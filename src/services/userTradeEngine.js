const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { WeexFuturesClient } = require('../api/weex/WeexFuturesClient');
const { LiveBroker } = require('./LiveBroker');
const { RiskGuard } = require('./riskGuard');
const { PositionManager } = require('./positionManager');

/**
 * UserTradeEngine — per-user isolated trading engine factory.
 *
 * Each connected user gets their own:
 *   - WeexFuturesClient (their API keys)
 *   - LiveBroker
 *   - RiskGuard (their risk settings)
 *   - PositionManager (their positions only)
 *
 * The shared signal analysis (agents + arbiter) produces a single decision.
 * fanOutDecision() distributes that decision to every active user engine.
 */
class UserTradeEngine {
    /**
     * @param {Object} opts
     * @param {import('./database').Database} opts.database
     * @param {import('./telegram').TelegramService} opts.telegram
     * @param {Object} opts.config - global config object
     * @param {Object} opts.metrics - Prometheus metrics
     */
    constructor({ database, telegram, config, metrics }) {
        this._db = database;
        this._telegram = telegram;
        this._config = config;
        this._metrics = metrics;

        /** @type {Map<string, UserEngine>} userId → engine */
        this._engines = new Map();
    }

    /**
     * Load all active users from DB and spin up their engines.
     * Called once at bootstrap.
     */
    async loadAllUsers() {
        const users = await this._db.getActiveUsers();
        logger.info('[UserTradeEngine] loading active users', { count: users.length });

        for (const row of users) {
            try {
                await this._bootUser(row);
            } catch (err) {
                logger.error('[UserTradeEngine] failed to boot user', {
                    userId: row.user_id, message: err.message
                });
            }
        }
        logger.info('[UserTradeEngine] all users loaded', { active: this._engines.size });
    }

    /**
     * Register a new user or re-activate an existing one.
     * @param {Object} userRow - raw DB row from users table
     */
    async addUser(userRow) {
        if (this._engines.has(userRow.user_id)) {
            // Already running — tear down and rebuild with new settings
            await this.removeUser(userRow.user_id);
        }
        await this._bootUser(userRow);
        logger.info('[UserTradeEngine] user added', { userId: userRow.user_id });
    }

    /**
     * Remove a user engine. Stops polling, cleans up references.
     */
    async removeUser(userId) {
        const engine = this._engines.get(userId);
        if (!engine) return;

        engine.positionManager.stopTpPolling?.();
        this._engines.delete(userId);
        logger.info('[UserTradeEngine] user removed', { userId });
    }

    /**
     * Update risk settings for a running user engine.
     */
    async updateUserRisk(userId, riskSettings) {
        const engine = this._engines.get(userId);
        if (!engine) {
            logger.warn('[UserTradeEngine] updateUserRisk: no engine for user', { userId });
            return;
        }

        // Rebuild RiskGuard with new config
        const riskConfig = this._buildRiskConfig(riskSettings);
        const newRiskGuard = new RiskGuard({
            config: riskConfig,
            getAvailableBalanceUsd: () => engine.broker.getAvailableBalanceUsd(),
            getOpenPositions: () => engine.positionManager.getOpen(),
            database: this._db,
            userId,
            persistPause: ({ paused, reason }) => this._db.updateUser(userId, {
                risk_paused: paused ? 1 : 0,
                risk_pause_reason: reason ?? null
            })
        });
        // Pass through the currently persisted paused flag so the kill-switch
        // survives a settings update.
        await newRiskGuard.init({
            paused: Boolean(riskSettings?.risk_paused),
            pauseReason: riskSettings?.risk_pause_reason || null
        });

        engine.riskGuard = newRiskGuard;
        engine.positionManager._riskGuard = newRiskGuard;
        logger.info('[UserTradeEngine] risk settings updated', { userId, riskConfig });
    }

    /**
     * CORE METHOD: Fan out a single arbiter decision to all active users.
     *
     * @param {Object} decision - arbiter decision with direction, symbol, risk.sizing
     * @param {Object} snapshot - indicator snapshot for re-computing sizing
     * @returns {Array<{userId, success, error?}>}
     */
    async fanOutDecision(decision, snapshot) {
        if (decision.outcome !== 'EXECUTE' || decision.direction === 'NEUTRAL') {
            return [];
        }

        const symbol = decision.symbol;
        const direction = decision.direction;

        // Per-user work is fully independent (different exchange accounts,
        // different risk state). Run in parallel so a slow user's REST call
        // doesn't delay everyone else. Promise.allSettled guarantees one
        // user's rejection never blocks the rest.
        const entries = Array.from(this._engines.entries());
        const settled = await Promise.allSettled(entries.map(async ([userId, engine]) => {
            // Check if user has this symbol enabled
            const userSymbols = engine.symbols || [];
            if (userSymbols.length > 0 && !userSymbols.includes(symbol)) {
                return { userId, success: false, reason: 'symbol_not_enabled' };
            }

            // Per-user risk evaluation
            const riskResult = await engine.riskGuard.evaluate({ symbol, direction });
            if (!riskResult.allow) {
                logger.info('[UserTradeEngine] user blocked by risk', {
                    userId, symbol, reason: riskResult.reason
                });
                return { userId, success: false, reason: riskResult.reason };
            }

            // Compute per-user sizing
            const sizing = this._computeUserSizing(engine, snapshot, direction, riskResult);
            if (!sizing) {
                return { userId, success: false, reason: 'sizing_failed' };
            }

            const markPrice = snapshot.indicators?.close
                ?? snapshot.candles?.[snapshot.candles.length - 1]?.close;

            // Open position on user's exchange account
            const position = await engine.positionManager.open({
                symbol,
                direction,
                markPrice,
                sizing,
                decisionId: decision.id
            });

            if (position) {
                // Notify THIS user specifically
                this._telegram.notifyPositionOpened?.(position, engine.chatId).catch(() => {});
                return { userId, success: true, positionId: position.positionId };
            }
            return { userId, success: false, reason: 'position_open_returned_null' };
        }));

        const results = settled.map((s, i) => {
            if (s.status === 'fulfilled') return s.value;
            const [userId] = entries[i];
            logger.error('[UserTradeEngine] fanOut error for user', {
                userId, symbol, message: s.reason?.message || String(s.reason)
            });
            return { userId, success: false, reason: s.reason?.message || 'unknown_error' };
        });

        logger.info('[UserTradeEngine] fanOut complete', {
            symbol, direction,
            total: this._engines.size,
            succeeded: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });

        return results;
    }

    /**
     * Get a specific user's engine.
     */
    getEngine(userId) {
        return this._engines.get(userId) || null;
    }

    /**
     * Get all active user IDs.
     */
    getAllActiveUserIds() {
        return Array.from(this._engines.keys());
    }

    /**
     * Get union of all user symbols for WebSocket subscriptions.
     */
    getAllSymbols() {
        const symbolSet = new Set();
        for (const engine of this._engines.values()) {
            for (const s of (engine.symbols || [])) {
                symbolSet.add(s);
            }
        }
        return Array.from(symbolSet);
    }

    /**
     * Dispatch mark price to all user engines that have positions on this symbol.
     */
    async onMarkPrice(symbol, price) {
        // Fan out in parallel — each PM's onMarkPrice is independent, and
        // mark-price ticks arrive at high frequency. Serial awaits would let
        // one slow user's exit check stall SL/TP evaluation for everyone else.
        const entries = Array.from(this._engines.entries());
        const settled = await Promise.allSettled(
            entries.map(([, engine]) => engine.positionManager.onMarkPrice(symbol, price))
        );
        for (let i = 0; i < settled.length; i++) {
            if (settled[i].status === 'rejected') {
                const [userId] = entries[i];
                logger.debug('[UserTradeEngine] onMarkPrice error', {
                    userId, symbol,
                    message: settled[i].reason?.message || String(settled[i].reason)
                });
            }
        }
    }

    // ─── Internal ──────────────────────────────────────────────────────────

    async _bootUser(row) {
        const apiKey = decrypt(row.encrypted_api_key);
        const secretKey = decrypt(row.encrypted_secret);
        const passphrase = decrypt(row.encrypted_passphrase);

        if (!apiKey || !secretKey || !passphrase) {
            throw new Error('Missing decrypted API credentials');
        }

        const client = new WeexFuturesClient({
            apiKey,
            secretKey,
            passphrase,
            onEvent: (event, payload) => {
                if (event === 'circuitOpen') {
                    logger.error('[UserTradeEngine] WEEX Circuit OPEN for user', {
                        userId: row.user_id, ...payload
                    });
                    this._telegram.sendMessage?.(
                        `🔴 *WEEX API Circuit Open*\nREST вызовы временно отключены.`,
                        row.telegram_chat_id
                    ).catch(() => {});
                }
            }
        });

        const broker = new LiveBroker({ client, userId: row.user_id });

        const symbols = (row.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
        const riskConfig = this._buildRiskConfig(row);

        const riskGuard = new RiskGuard({
            config: riskConfig,
            getAvailableBalanceUsd: () => broker.getAvailableBalanceUsd(),
            getOpenPositions: () => positionManager.getOpen(),
            database: this._db,
            userId: row.user_id,
            persistPause: ({ paused, reason }) => this._db.updateUser(row.user_id, {
                risk_paused: paused ? 1 : 0,
                risk_pause_reason: reason ?? null
            })
        });
        await riskGuard.init({
            paused: Boolean(row.risk_paused),
            pauseReason: row.risk_pause_reason || null
        });

        const positionManager = new PositionManager({
            database: this._db,
            broker,
            riskGuard,
            config: this._config,
            userId: row.user_id,
            minNotionalUsd: this._config.risk?.exchangeMinNotionalUsd,
            onEvent: (event, payload) => {
                logger.info(`[UserTradeEngine:${row.user_id}] ${event}`, payload);
                if (event === 'positionClosed' && payload?.position) {
                    this._telegram.notifyPositionClosed?.(
                        { position: payload.position, reason: payload.reason, pnl: payload.pnl },
                        row.telegram_chat_id
                    ).catch(() => {});
                } else if (event === 'partialClose' && payload?.position) {
                    this._telegram.notifyTakeProfitHit?.(
                        { position: payload.position, level: payload.level, pnl: payload.pnl },
                        row.telegram_chat_id
                    ).catch(() => {});
                }
            }
        });

        // Sync with exchange and start TP polling
        await positionManager.syncWithExchange();
        positionManager.startTpPolling();

        this._engines.set(row.user_id, {
            client,
            broker,
            riskGuard,
            positionManager,
            chatId: row.telegram_chat_id,
            symbols,
            userId: row.user_id
        });
    }

    _buildRiskConfig(row) {
        return {
            maxDailyLossPercent: row.risk_max_daily_loss_pct ?? 3,
            maxConcurrentPositions: row.risk_max_positions ?? 3,
            defaultLeverage: row.risk_leverage ?? 5,
            maxPositionSizePercent: row.risk_position_size_pct ?? 5,
            correlationPenaltyEnabled: false,
            exchangeMinNotionalUsd: this._config.risk?.exchangeMinNotionalUsd ?? 5,
            slAtrMult: this._config.risk?.slAtrMult ?? 3.0,
            tp1AtrMult: this._config.risk?.tp1AtrMult ?? 2.0,
            tp2AtrMult: this._config.risk?.tp2AtrMult ?? 3.0,
            tp3AtrMult: this._config.risk?.tp3AtrMult ?? 6.0,
            riskPerTradePercent: row.risk_position_size_pct ?? 5
        };
    }

    _computeUserSizing(engine, snapshot, direction, riskResult) {
        const atrValue = snapshot.indicators?.atr;
        const close = snapshot.indicators?.close;
        if (!Number.isFinite(atrValue) || !Number.isFinite(close) || atrValue <= 0) return null;

        const riskConfig = this._buildRiskConfig({
            risk_position_size_pct: engine.riskGuard?._config?.maxPositionSizePercent ?? 5,
            risk_leverage: engine.riskGuard?._config?.defaultLeverage ?? 5
        });

        // Get balance from cache (broker already has it)
        const balance = engine.broker._lastBalance;
        if (!Number.isFinite(balance) || balance <= 0) return null;

        const riskPct = riskConfig.maxPositionSizePercent;
        const leverage = riskConfig.defaultLeverage;
        const sizingMultiplier = riskResult.sizingMultiplier ?? 1;
        const notionalUsd = balance * (riskPct / 100) * sizingMultiplier;
        const quantity = (notionalUsd * leverage) / close;

        const slDistance = atrValue * riskConfig.slAtrMult;
        const tp1Distance = atrValue * riskConfig.tp1AtrMult;
        const tp2Distance = atrValue * riskConfig.tp2AtrMult;
        const tp3Distance = atrValue * riskConfig.tp3AtrMult;

        const sign = direction === 'LONG' ? 1 : -1;

        return {
            quantity,
            notionalUsd,
            leverage,
            stopLoss: close - sign * slDistance,
            takeProfits: [
                { level: 1, price: close + sign * tp1Distance, closePercent: 50 },
                { level: 2, price: close + sign * tp2Distance, closePercent: 30 },
                { level: 3, price: close + sign * tp3Distance, closePercent: 20 }
            ]
        };
    }
}

module.exports = { UserTradeEngine };
