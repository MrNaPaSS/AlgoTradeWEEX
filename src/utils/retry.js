const pRetry = require('p-retry');
const logger = require('./logger');

const DEFAULT_OPTIONS = {
    retries: 3,
    minTimeout: 300,
    maxTimeout: 3000,
    factor: 2
};

/**
 * Retry an async operation with exponential backoff.
 * AbortError from p-retry will short-circuit retries.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Object} [options]
 * @param {string} [options.name] Operation label for logs
 * @param {number} [options.retries]
 * @returns {Promise<T>}
 */
async function withRetry(fn, options = {}) {
    const { name = 'op', retries = DEFAULT_OPTIONS.retries, ...rest } = options;

    return pRetry(
        async (attempt) => {
            try {
                return await fn(attempt);
            } catch (error) {
                if (error && (error.name === 'AbortError' || error.noRetry === true)) {
                    throw error;
                }
                logger.warn(`[retry:${name}] attempt ${attempt} failed`, { message: error.message });
                throw error;
            }
        },
        { ...DEFAULT_OPTIONS, ...rest, retries }
    );
}

module.exports = { withRetry };
