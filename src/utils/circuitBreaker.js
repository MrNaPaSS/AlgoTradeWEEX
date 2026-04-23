const CircuitBreaker = require('opossum');
const logger = require('./logger');

const DEFAULTS = {
    timeout: 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 60000,
    rollingCountBuckets: 10
};

/**
 * Wrap an async function with a circuit breaker (opossum).
 * @template T
 * @param {(...args: any[]) => Promise<T>} fn
 * @param {Object} [options]
 * @param {string} [options.name]
 * @returns {CircuitBreaker}
 */
function createBreaker(fn, options = {}) {
    const name = options.name || fn.name || 'anonymous';
    const breaker = new CircuitBreaker(fn, { ...DEFAULTS, ...options, name });

    breaker.on('open', () => logger.warn(`[breaker:${name}] OPEN`));
    breaker.on('halfOpen', () => logger.info(`[breaker:${name}] HALF_OPEN`));
    breaker.on('close', () => logger.info(`[breaker:${name}] CLOSED`));
    breaker.on('reject', () => logger.debug(`[breaker:${name}] REJECTED (circuit open)`));
    breaker.on('timeout', () => logger.warn(`[breaker:${name}] TIMEOUT`));

    return breaker;
}

module.exports = { createBreaker };
