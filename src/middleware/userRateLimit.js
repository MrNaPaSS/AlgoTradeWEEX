const rateLimit = require('express-rate-limit');

/**
 * Per-user rate limiting for Mini App API endpoints.
 *
 * userId is extracted from req.telegramUser (set by telegramAuth middleware).
 * Falls back to IP if telegramUser is not yet set (should not happen in practice).
 */

const keyByUserId = (req) =>
    req.telegramUser?.id || req.ip;

/** 30 requests/min for general API use */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: keyByUserId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests — please slow down (30 req/min)' }
});

/** 5 requests/min for registration (prevents brute-force key validation) */
const registerLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    keyGenerator: keyByUserId,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many registration attempts (5 req/min)' }
});

module.exports = { apiLimiter, registerLimiter };
