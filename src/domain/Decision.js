const { nanoid } = require('nanoid');

const VALID_OUTCOMES = new Set(['EXECUTE', 'HOLD', 'REJECT']);
const VALID_DIRECTIONS = new Set(['LONG', 'SHORT', 'NEUTRAL']);

/**
 * Build an immutable Decision record.
 * @param {Object} input
 * @returns {import('./types').Decision}
 */
function createDecision(input) {
    const {
        signalId,
        symbol,
        outcome,
        direction,
        confidence,
        votes,
        risk,
        arbiterReasoning,
        arbiterMode,
        llmInvoked = false
    } = input;

    if (!VALID_OUTCOMES.has(outcome)) {
        throw new TypeError(`[Decision] outcome must be one of ${[...VALID_OUTCOMES].join('|')}`);
    }
    if (!VALID_DIRECTIONS.has(direction)) {
        throw new TypeError(`[Decision] direction must be one of ${[...VALID_DIRECTIONS].join('|')}`);
    }
    if (!Array.isArray(votes)) {
        throw new TypeError('[Decision] votes must be an array');
    }

    return Object.freeze({
        id: nanoid(12),
        signalId,
        symbol,
        outcome,
        direction,
        confidence,
        votes: Object.freeze([...votes]),
        risk: Object.freeze({ ...risk, warnings: Object.freeze([...(risk?.warnings || [])]) }),
        arbiterReasoning: arbiterReasoning || '',
        arbiterMode,
        llmInvoked: Boolean(llmInvoked),
        createdAt: Date.now()
    });
}

module.exports = { createDecision, VALID_OUTCOMES, VALID_DIRECTIONS };
