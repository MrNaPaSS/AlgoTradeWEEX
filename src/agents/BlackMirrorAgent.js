const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');

/**
 * BLACK MIRROR ULTRA predictor as a confirming agent.
 * Signal is emitted when score ≥ threshold (default 3 on a 0–4 scale).
 */
class BlackMirrorAgent extends BaseAgent {
    constructor({ threshold = 3 } = {}) {
        super('BlackMirrorAgent');
        this._threshold = threshold;
    }

    async _analyze(snapshot) {
        const bm = snapshot.indicators?.blackMirror;
        if (!bm) {
            return createVote({
                agent: this.name,
                direction: 'NEUTRAL',
                confidence: 0,
                reasoning: 'blackMirror indicators missing'
            });
        }

        const { scoreLong, scoreShort, longSignal, shortSignal } = bm;

        if (longSignal && scoreLong >= this._threshold) {
            return createVote({
                agent: this.name,
                direction: 'LONG',
                confidence: scoreLong / 4,
                reasoning: `BM long score=${scoreLong}/4`,
                metrics: { scoreLong, scoreShort }
            });
        }
        if (shortSignal && scoreShort >= this._threshold) {
            return createVote({
                agent: this.name,
                direction: 'SHORT',
                confidence: scoreShort / 4,
                reasoning: `BM short score=${scoreShort}/4`,
                metrics: { scoreLong, scoreShort }
            });
        }

        const dominant = scoreLong >= scoreShort ? 'long-leaning' : 'short-leaning';
        return createVote({
            agent: this.name,
            direction: 'NEUTRAL',
            confidence: Math.max(scoreLong, scoreShort) / 8,
            reasoning: `BM below threshold (${dominant}: L=${scoreLong} S=${scoreShort})`,
            metrics: { scoreLong, scoreShort }
        });
    }
}

module.exports = { BlackMirrorAgent };
