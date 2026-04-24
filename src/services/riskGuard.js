const logger = require('../utils/logger');

/**
 * RiskGuard — centralised risk governance.
 *
 * Responsibilities:
 *   - Kill-switch (manual pause / resume)
 *   - Daily realised-loss limit
 *   - Max concurrent open positions
 *   - Per-symbol duplication guard (no double LONG)
 *   - Correlated exposure guard (BTC/ETH/SOL/BNB/XRP/ADA cluster)
 *
 * Stateful but persistence-agnostic: database injects a `persistence`
 * adapter with `loadState` / `saveState` for daily PnL rollover.
 */
class RiskGuard {
    /**
     * @param {Object} opts
     * @param {Object} opts.config   The `config.risk` sub-tree
     * @param {() => number} opts.getAvailableBalanceUsd
     * @param {() => import('../domain/types').Position[]} opts.getOpenPositions
     * @param {Object} [opts.database]  Optional central database for KV persistence
     * @param {Function} [opts.onEvent]  Callback for risk events (paused, resumed, etc.)
     * @param {Object} [opts.metrics]   Prometheus metrics object
     */
    constructor({ config, getAvailableBalanceUsd, getOpenPositions, database, onEvent, metrics, userId, persistPause } = {}) {
        this._config = config;
        this._balanceFn = getAvailableBalanceUsd;
        this._positionsFn = getOpenPositions;
        this._db = database || null;
        this._onEvent = onEvent || null;
        this._metrics = metrics || null;
        this._userId = userId || null;
        // Optional async hook: ({ paused, reason }) => Promise<void>
        // Used to persist the kill-switch flag per user (e.g. users.risk_paused column).
        this._persistPause = typeof persistPause === 'function' ? persistPause : null;
        // Serialize persist writes: rapid pause/resume toggles (manual toggle
        // colliding with auto daily-loss trigger) would race otherwise and
        // leave DB out of sync with in-memory state. The chain guarantees the
        // LAST enqueued write wins, matching the in-memory ordering.
        this._persistChain = Promise.resolve();

        this._paused = false;
        this._pauseReason = null;
        this._dayKey = this._today();
        this._realisedPnlUsd = 0;
        this._startOfDayBalance = null;

        // Per-user KV key — avoids colliding state across users when DB is shared.
        // Fallback key `riskGuard:state` is only used when userId is absent (single-tenant dev mode).
        this._kvKey = this._userId ? `riskGuard:${this._userId}:state` : 'riskGuard:state';
    }

    async init({ paused = false, pauseReason = null } = {}) {
        // Restore persisted kill-switch flag first
        if (paused) {
            this._paused = true;
            this._pauseReason = pauseReason || 'restored';
            logger.info('[RiskGuard] restored paused state', { userId: this._userId, reason: this._pauseReason });
        }
        if (!this._db) return;
        try {
            const snap = await this._db.kvGet(this._kvKey);
            if (snap && snap.dayKey === this._today()) {
                this._realisedPnlUsd = snap.realisedPnlUsd || 0;
                this._startOfDayBalance = snap.startOfDayBalance ?? null;
                logger.info('[RiskGuard] restored state from DB', { realisedPnlUsd: this._realisedPnlUsd });
            }
        } catch (err) {
            logger.warn('[RiskGuard] failed to load persisted state', { message: err.message });
        }
        if (this._startOfDayBalance === null) {
            try {
                this._startOfDayBalance = await this._balanceFn();
            } catch (err) {
                logger.warn('[RiskGuard] init balance fetch failed', { message: err.message });
                this._startOfDayBalance = 0;
            }
            await this._flush();
        }
    }

    pause(reason = 'manual') {
        if (this._paused && this._pauseReason === reason) return;
        this._paused = true;
        this._pauseReason = reason;
        logger.warn('[RiskGuard] trading paused', { userId: this._userId, reason });

        this._enqueuePersist({ paused: true, reason });
        if (this._onEvent) this._onEvent('paused', { reason });
        if (this._metrics?.riskPausesTotal) {
            this._metrics.riskPausesTotal.labels(reason).inc();
        }
    }

    resume() {
        if (!this._paused) return;
        this._paused = false;
        this._pauseReason = null;
        logger.info('[RiskGuard] trading resumed', { userId: this._userId });
        this._enqueuePersist({ paused: false, reason: null });
        if (this._onEvent) this._onEvent('resumed', {});
    }

    /**
     * Enqueue a persistence write on a serial promise chain. Chain absorbs
     * errors so a failed write never poisons subsequent ones.
     * @param {{paused:boolean, reason:string|null}} state
     */
    _enqueuePersist(state) {
        if (!this._persistPause) return;
        this._persistChain = this._persistChain
            .then(() => this._persistPause(state))
            .catch((err) => logger.warn('[RiskGuard] persistPause failed', {
                userId: this._userId, paused: state.paused, message: err.message
            }));
    }

    get isPaused() {
        return this._paused;
    }

    /** Called by execution layer after a position is closed. */
    async recordRealisedPnl(pnlUsd) {
        await this._rolloverIfNewDay();
        if (!Number.isFinite(pnlUsd)) {
            logger.warn('[RiskGuard] recordRealisedPnl ignored non-finite value', { pnlUsd });
            return;
        }
        this._realisedPnlUsd += pnlUsd;
        await this._flush();
    }

    /**
     * Evaluate whether executing the intended direction is allowed.
     * @param {{ symbol: string, direction: 'LONG'|'SHORT' }} ctx
     * @returns {Promise<{ allow: boolean, reason?: string, warnings: string[] }>}
     */
    async evaluate({ symbol, direction }) {
        await this._rolloverIfNewDay();
        const warnings = [];

        if (this._paused) {
            const reason = `paused: ${this._pauseReason}`;
            if (this._metrics?.riskPausesTotal) {
                this._metrics.riskPausesTotal.labels(this._pauseReason || 'unknown').inc();
            }
            return { allow: false, reason, warnings };
        }
        if (direction !== 'LONG' && direction !== 'SHORT') {
            return { allow: false, reason: `invalid direction ${direction}`, warnings };
        }

        const balance = await this._balanceFn();
        if (!Number.isFinite(balance) || balance <= 0) {
            return { allow: false, reason: 'no available balance', warnings };
        }

        const baseline = this._startOfDayBalance || balance;
        const dailyLossPct = baseline > 0 ? (-this._realisedPnlUsd / baseline) * 100 : 0;
        if (dailyLossPct >= this._config.maxDailyLossPercent) {
            const reason = `daily loss limit hit: ${dailyLossPct.toFixed(2)}% ≥ ${this._config.maxDailyLossPercent}%`;
            this.pause(reason);
            return { allow: false, reason, warnings };
        }
        if (dailyLossPct > this._config.maxDailyLossPercent * 0.7) {
            warnings.push(`approaching daily loss cap (${dailyLossPct.toFixed(2)}%)`);
        }

        const positions = (typeof this._positionsFn === 'function' ? this._positionsFn() : this._positionsFn) || [];
        logger.debug('[RiskGuard] evaluating', { symbol, direction, openCount: positions.length });

        if (positions.length >= this._config.maxConcurrentPositions) {
            return {
                allow: false,
                reason: `max concurrent positions reached (${positions.length}/${this._config.maxConcurrentPositions})`,
                warnings
            };
        }

        const sameSymbol = positions.find((p) => String(p.symbol).toUpperCase() === String(symbol).toUpperCase());
        if (sameSymbol) {
            const existingDir = String(sameSymbol.side).toUpperCase(); // 'LONG' or 'SHORT'
            const intendedDir = String(direction).toUpperCase();

            if (existingDir === intendedDir) {
                logger.warn('[RiskGuard] duplication veto', { symbol, direction });
                return { allow: false, reason: `already ${existingDir} on ${symbol}`, warnings };
            }
            warnings.push(`opposing ${existingDir} position on ${symbol} still open`);
        }

        // Correlation penalty (Variant B): does NOT block, but returns a sizing multiplier.
        if (!this._config.correlationPenaltyEnabled) {
            return { allow: true, warnings, sizingMultiplier: 1, correlation: { multiplier: 1, correlatedCount: 0, disabled: true } };
        }
        const penalty = this._computeCorrelationPenalty(symbol, direction, positions);
        if (penalty.multiplier < 1) {
            warnings.push(
                `correlated cluster exposure (${penalty.correlatedCount} position(s)) — sizing reduced to ${(penalty.multiplier * 100).toFixed(0)}%`
            );
            if (this._metrics?.correlationPenaltiesTotal) {
                this._metrics.correlationPenaltiesTotal.labels(penalty.cluster || 'unknown').inc();
            }
        }

        return { allow: true, warnings, sizingMultiplier: penalty.multiplier, correlation: penalty };
    }

    /**
     * Variant B — correlation sizing penalty.
     * multiplier = 0.5 ^ correlatedCount, clamped at 0.125 (min 12.5%).
     * Only counts same-direction positions within the BTC/ETH/SOL/BNB/XRP/ADA cluster.
     */
    _computeCorrelationPenalty(symbol, direction, positions) {
        const cryptoCluster = /^(BTC|ETH|SOL|BNB|XRP|ADA)USDT$/i;
        if (!cryptoCluster.test(symbol)) {
            return { multiplier: 1, correlatedCount: 0, cluster: null };
        }
        const dirLower = String(direction).toLowerCase();
        const correlated = positions.filter(
            (p) =>
                cryptoCluster.test(p.symbol) &&
                String(p.symbol).toUpperCase() !== String(symbol).toUpperCase() &&
                String(p.side).toLowerCase() === dirLower
        );
        const count = correlated.length;
        if (count === 0) return { multiplier: 1, correlatedCount: 0, cluster: 'crypto-majors' };

        const raw = Math.pow(0.5, count);   // 1 → 0.5, 2 → 0.25, 3 → 0.125, 4+ → 0.0625
        const multiplier = Math.max(0.125, raw);
        return {
            multiplier,
            correlatedCount: count,
            correlatedSymbols: correlated.map((p) => p.symbol),
            cluster: 'crypto-majors'
        };
    }

    snapshot() {
        return {
            paused: this._paused,
            pauseReason: this._pauseReason,
            dayKey: this._dayKey,
            realisedPnlUsd: Number(this._realisedPnlUsd.toFixed(4)),
            startOfDayBalance: this._startOfDayBalance,
            dailyLossPercent: this._startOfDayBalance
                ? Number(((-this._realisedPnlUsd / this._startOfDayBalance) * 100).toFixed(3))
                : 0
        };
    }

    _today() {
        return new Date().toISOString().slice(0, 10);
    }

    async _rolloverIfNewDay() {
        const key = this._today();
        if (key === this._dayKey) return;
        logger.info('[RiskGuard] daily rollover', { from: this._dayKey, to: key });
        this._dayKey = key;
        this._realisedPnlUsd = 0;
        try {
            const bal = await this._balanceFn();
            if (Number.isFinite(bal) && bal > 0) {
                this._startOfDayBalance = bal;
            } else {
                logger.warn('[RiskGuard] rollover: balance fn returned invalid value, keeping previous baseline', { bal });
            }
        } catch (err) {
            logger.warn('[RiskGuard] rollover balance fetch failed, keeping previous baseline', { message: err.message });
        }
        await this._flush();
    }

    async _flush() {
        if (!this._db) return;
        try {
            await this._db.kvSet(this._kvKey, {
                dayKey: this._dayKey,
                realisedPnlUsd: this._realisedPnlUsd,
                startOfDayBalance: this._startOfDayBalance
            });
        } catch (err) {
            logger.warn('[RiskGuard] failed to persist state', { message: err.message });
        }
    }
}

module.exports = { RiskGuard };
