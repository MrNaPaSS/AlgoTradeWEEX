const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');

/**
 * Contrarian sentiment agent.
 *   fearGreed < 25 (extreme fear)  → LONG bias
 *   fearGreed > 75 (extreme greed) → SHORT bias
 *   25-75                          → NEUTRAL
 *
 * Applies only to crypto symbols — gold (XAUT) receives NEUTRAL.
 */
class SentimentAgent extends BaseAgent {
    constructor({ fearGreedClient } = {}) {
        super('SentimentAgent');
        this._client = fearGreedClient;
    }

    async _analyze(snapshot) {
        const isCrypto = /^(BTC|ETH|SOL|BNB|XRP|ADA)/i.test(snapshot.symbol);
        if (!isCrypto) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 0,
                reasoning: 'non-crypto symbol — sentiment skipped'
            });
        }

        let fg = snapshot.fearGreedIndex;
        if (fg === undefined && this._client) {
            const res = await this._client.getCurrent();
            fg = res?.value;
        }
        if (!Number.isFinite(fg)) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 0,
                reasoning: 'fear & greed unavailable'
            });
        }

        if (fg < 25) {
            const confidence = Math.min(1, (25 - fg) / 25);
            return createVote({
                agent: this.name,
                direction: 'LONG',
                confidence,
                reasoning: `extreme fear (${fg}) → contrarian LONG`,
                metrics: { fearGreed: fg }
            });
        }
        if (fg > 75) {
            const confidence = Math.min(1, (fg - 75) / 25);
            return createVote({
                agent: this.name,
                direction: 'SHORT',
                confidence,
                reasoning: `extreme greed (${fg}) → contrarian SHORT`,
                metrics: { fearGreed: fg }
            });
        }
        return createVote({
            agent: this.name,
            direction: 'NEUTRAL',
            confidence: 0,
            reasoning: `sentiment neutral (${fg})`,
            metrics: { fearGreed: fg }
        });
    }
}

module.exports = { SentimentAgent };
