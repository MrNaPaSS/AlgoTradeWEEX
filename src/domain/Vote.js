const VALID_DIRECTIONS = new Set(['LONG', 'SHORT', 'NEUTRAL']);

/**
 * Create an immutable Vote object.
 * @param {Object} input
 * @param {string} input.agent
 * @param {'LONG'|'SHORT'|'NEUTRAL'} input.direction
 * @param {number} input.confidence
 * @param {string} input.reasoning
 * @param {boolean} [input.veto]
 * @param {Record<string, unknown>} [input.metrics]
 * @returns {import('./types').Vote}
 */
function createVote({ agent, direction, confidence, reasoning, veto = false, metrics = {} }) {
    if (typeof agent !== 'string' || !agent.length) {
        throw new TypeError('[Vote] agent must be a non-empty string');
    }
    if (!VALID_DIRECTIONS.has(direction)) {
        throw new TypeError(`[Vote] direction must be one of ${[...VALID_DIRECTIONS].join('|')}`);
    }
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1 || Number.isNaN(confidence)) {
        throw new TypeError('[Vote] confidence must be a number in [0, 1]');
    }
    return Object.freeze({
        agent,
        direction,
        confidence,
        veto: Boolean(veto),
        reasoning: reasoning || '',
        metrics: Object.freeze({ ...metrics })
    });
}

const NEUTRAL_VOTE = (agent, reasoning = 'insufficient data') =>
    createVote({ agent, direction: 'NEUTRAL', confidence: 0, reasoning });

module.exports = { createVote, NEUTRAL_VOTE, VALID_DIRECTIONS };
