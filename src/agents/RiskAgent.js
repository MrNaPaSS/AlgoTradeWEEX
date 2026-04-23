const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');

/**
 * RiskAgent returns a veto Vote plus a PositionSizing recommendation stored in metrics.
 * It does NOT try to forecast direction — direction is passed in via `intendedDirection`
 * on the snapshot's triggeringSignal (derived upstream). Instead it evaluates whether
 * executing that intended direction is allowed under current risk constraints.
 */
class RiskAgent extends BaseAgent {
    /**
     * @param {Object} opts
     * @param {import('../services/riskGuard').RiskGuard} opts.riskGuard
     * @param {Object} opts.riskConfig  (from config.risk)
     * @param {() => number} opts.getAvailableBalanceUsd
     */
    constructor({ riskGuard, riskConfig, getAvailableBalanceUsd }) {
        super('RiskAgent');
        this._guard = riskGuard;
        this._config = riskConfig;
        this._balanceFn = getAvailableBalanceUsd;
    }

    async _analyze(snapshot) {
        const symbol = snapshot.symbol;
        const intendedDirection = snapshot.triggeringSignal
            ? snapshot.triggeringSignal.signalType.includes('LONG') ||
              snapshot.triggeringSignal.signalType === 'CE_BUY'
                ? 'LONG'
                : 'SHORT'
            : 'NEUTRAL';

        const guardCheck = await this._guard.evaluate({ symbol, direction: intendedDirection });
        if (!guardCheck.allow) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 1,
                veto: true,
                reasoning: `РИСК ВЕТО: ${guardCheck.reason}`,
                metrics: { sizing: null, guard: guardCheck }
            });
        }

        const sizingMultiplier = guardCheck.sizingMultiplier ?? 1;
        const sizing = await this._computeSizing(snapshot, intendedDirection, sizingMultiplier);
        if (!sizing) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 1,
                veto: true,
                reasoning: 'РИСК ВЕТО: невозможно рассчитать размер позиции (отсутствует ATR или баланс)',
                metrics: { sizing: null }
            });
        }

        const corrInfo = guardCheck.correlation || {};
        const corrNote = corrInfo.correlatedCount > 0
            ? ` | corr×${sizingMultiplier.toFixed(3)} (${corrInfo.correlatedCount} in cluster)`
            : '';

        return createVote({
            agent: this.name,
            direction: intendedDirection,
            confidence: 0.7,
            veto: false,
            reasoning: `риск в норме — объем=$${sizing.notionalUsd.toFixed(2)} плечо=${sizing.leverage}x SL=${sizing.stopLoss.toFixed(2)}${corrNote}`,
            metrics: {
                sizing,
                warnings: guardCheck.warnings || [],
                correlation: corrInfo,
                sizingMultiplier
            }
        });
    }

    async _computeSizing(snapshot, direction, sizingMultiplier = 1) {
        if (direction === 'NEUTRAL') return null;
        const atrValue = snapshot.indicators?.atr;
        const close = snapshot.indicators?.close;
        if (!Number.isFinite(atrValue) || !Number.isFinite(close) || atrValue <= 0) return null;

        const balanceUsd = await this._balanceFn();
        if (!Number.isFinite(balanceUsd) || balanceUsd <= 0) return null;

        // Dynamic sizing: balance × risk_per_trade_%
        const riskPct = this._config.maxPositionSizePercent || 5;
        const baseNotionalUsd = balanceUsd * (riskPct / 100);
        
        const notionalUsd = baseNotionalUsd * sizingMultiplier;
        const leverage = this._config.defaultLeverage || 5;
        const quantity = (notionalUsd * leverage) / close; // Total leveraged position size

        const slDistance = atrValue * this._config.slAtrMult;
        const tp1Distance = atrValue * this._config.tp1AtrMult;
        const tp2Distance = atrValue * this._config.tp2AtrMult;
        const tp3Distance = atrValue * this._config.tp3AtrMult;

        const sign = direction === 'LONG' ? 1 : -1;
        const stopLoss = close - sign * slDistance;
        const tp1 = close + sign * tp1Distance;
        const tp2 = close + sign * tp2Distance;
        const tp3 = close + sign * tp3Distance;

        return {
            quantity,
            notionalUsd,
            leverage,
            stopLoss,
            takeProfits: [
                { level: 1, price: tp1, closePercent: 50 },
                { level: 2, price: tp2, closePercent: 30 },
                { level: 3, price: tp3, closePercent: 20 }
            ]
        };
    }
}

module.exports = { RiskAgent };
