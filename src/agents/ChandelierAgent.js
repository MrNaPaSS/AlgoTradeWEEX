const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');

/**
 * Chandelier Exit trend agent.
 * Fresh reversal (buy/sell signal on last bar) → high confidence.
 * Ongoing trend (no reversal but direction defined) → medium confidence.
 */
class ChandelierAgent extends BaseAgent {
    constructor() {
        super('ChandelierAgent');
    }

    async _analyze(snapshot) {
        const sig = snapshot.triggeringSignal?.type || snapshot.triggeringSignal?.signalType;
        if (sig === 'CE_BUY' || sig === 'LONG') {
            return createVote({
                agent: this.name,
                direction: 'LONG',
                confidence: 1.0,
                reasoning: 'forced webhook signal: BUY'
            });
        }
        if (sig === 'CE_SELL' || sig === 'SHORT') {
            return createVote({
                agent: this.name,
                direction: 'SHORT',
                confidence: 1.0,
                reasoning: 'forced webhook signal: SELL'
            });
        }

        const ce = snapshot.indicators?.chandelier;
        if (!ce) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 0,
                reasoning: 'chandelier indicators missing'
            });
        }
        
        const { direction, buySignal, sellSignal, longStop, shortStop } = ce;

        if (buySignal) {
            return createVote({
                agent: this.name,
                direction: 'LONG',
                confidence: 0.9,
                reasoning: 'CE buy reversal',
                metrics: { longStop, shortStop }
            });
        }
        if (sellSignal) {
            return createVote({
                agent: this.name,
                direction: 'SHORT',
                confidence: 0.9,
                reasoning: 'CE sell reversal',
                metrics: { longStop, shortStop }
            });
        }
        if (direction === 1) {
            return createVote({
                agent: this.name,
                direction: 'LONG',
                confidence: 0.5,
                reasoning: 'CE trend: long',
                metrics: { longStop, shortStop }
            });
        }
        if (direction === -1) {
            return createVote({
                agent: this.name,
                direction: 'SHORT',
                confidence: 0.5,
                reasoning: 'CE trend: short',
                metrics: { longStop, shortStop }
            });
        }
        return createVote({
            agent: this.name,
            direction: 'NEUTRAL',
            confidence: 0,
            reasoning: 'no direction'
        });
    }
}

module.exports = { ChandelierAgent };
