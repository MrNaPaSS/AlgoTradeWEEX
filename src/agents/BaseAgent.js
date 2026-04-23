const { NEUTRAL_VOTE } = require('../domain/Vote');
const logger = require('../utils/logger');

/**
 * Abstract base for all analysis agents.
 * Subclasses override `_analyze(snapshot)` and return a Vote.
 * `analyze()` wraps it with uniform error handling so one faulty agent
 * cannot crash the consilium.
 */
class BaseAgent {
    constructor(name) {
        if (new.target === BaseAgent) {
            throw new Error('[BaseAgent] cannot be instantiated directly');
        }
        this.name = name;
    }

    /**
     * Public entry point — never throws.
     * @param {import('../domain/types').MarketSnapshot} snapshot
     * @returns {Promise<import('../domain/types').Vote>}
     */
    async analyze(snapshot) {
        try {
            const vote = await this._analyze(snapshot);
            if (!vote || typeof vote !== 'object') {
                return NEUTRAL_VOTE(this.name, 'no vote produced');
            }
            return vote;
        } catch (err) {
            logger.warn(`[${this.name}] analyze failed`, { message: err.message });
            return NEUTRAL_VOTE(this.name, `error: ${err.message}`);
        }
    }

    // eslint-disable-next-line no-unused-vars
    async _analyze(snapshot) {
        throw new Error('[BaseAgent] subclasses must implement _analyze()');
    }
}

module.exports = { BaseAgent };
