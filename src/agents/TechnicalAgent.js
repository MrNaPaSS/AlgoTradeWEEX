const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');

/**
 * Combines RSI, MACD, Bollinger position, and Stochastic into a single vote.
 * Each sub-indicator contributes +1/-1 to a net score; confidence scales with |score|/maxScore.
 */
class TechnicalAgent extends BaseAgent {
    constructor() {
        super('TechnicalAgent');
    }

    async _analyze(snapshot) {
        const { indicators } = snapshot;
        const { rsi, macd, bollinger, close, stochastic } = indicators;

        const signals = [];
        let score = 0;

        if (Number.isFinite(rsi)) {
            if (rsi < 30) { score += 1; signals.push(`RSI oversold (${rsi.toFixed(1)})`); }
            else if (rsi > 70) { score -= 1; signals.push(`RSI overbought (${rsi.toFixed(1)})`); }
        }

        if (macd && Number.isFinite(macd.histogram)) {
            if (macd.histogram > 0 && macd.macd > macd.signal) { score += 1; signals.push('MACD bullish'); }
            else if (macd.histogram < 0 && macd.macd < macd.signal) { score -= 1; signals.push('MACD bearish'); }
        }

        if (bollinger && Number.isFinite(bollinger.upper) && Number.isFinite(bollinger.lower)) {
            if (close <= bollinger.lower) { score += 1; signals.push('price ≤ lower BB (mean-revert long)'); }
            else if (close >= bollinger.upper) { score -= 1; signals.push('price ≥ upper BB (mean-revert short)'); }
        }

        if (stochastic && Number.isFinite(stochastic.k)) {
            if (stochastic.k < 20) { score += 1; signals.push(`Stoch %K ${stochastic.k.toFixed(1)} oversold`); }
            else if (stochastic.k > 80) { score -= 1; signals.push(`Stoch %K ${stochastic.k.toFixed(1)} overbought`); }
        }

        const maxScore = 4;
        const direction = score > 0 ? 'LONG' : score < 0 ? 'SHORT' : 'NEUTRAL';
        const confidence = Math.min(1, Math.abs(score) / maxScore);

        return createVote({
            agent: this.name,
            direction,
            confidence,
            reasoning: signals.length ? signals.join('; ') : 'no strong technical signal',
            metrics: { score, maxScore, rsi, macdHist: macd?.histogram }
        });
    }
}

module.exports = { TechnicalAgent };
