const rateLimit = require('express-rate-limit');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Adaptive Rate Limiter for Webhooks.
 * Implements two layers: 
 *   1. Burst (10 req/sec)
 *   2. Sustained (60 req/min)
 */

const createLimiter = (windowMs, max, type) => rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Per-IP + per-webhook-secret keying
        const secret = req.body?.secret || 'no-secret';
        return `${req.ip}_${secret}`;
    },
    handler: (req, res, next, options) => {
        const secret = req.body?.secret ? '***' : 'none';
        logger.warn(`[RateLimit] ${type} limit exceeded`, { 
            ip: req.ip, 
            secret,
            windowMs, 
            max 
        });

        // Log to risk_events if database is available
        const db = req.app.get('db');
        if (db) {
            Promise.resolve(db.insertRiskEvent({
                eventType: 'RATE_LIMIT_EXCEEDED',
                symbol: req.body?.symbol || null,
                reason: `${type} limit: ${max} req / ${windowMs}ms`,
                meta: { ip: req.ip, type }
            })).catch(() => {});
        }

        res.status(429).json(options.message);
    },
    message: { 
        success: false, 
        error: { 
            code: 'RATE_LIMITED', 
            message: `Too many requests (${type} limit exceeded)` 
        } 
    }
});

const burstLimiter = createLimiter(1000, 10, 'BURST');
const sustainedLimiter = createLimiter(60 * 1000, config.webhook.rateLimitPerMinute || 60, 'SUSTAINED');

const webhookRateLimiter = [burstLimiter, sustainedLimiter];

module.exports = { webhookRateLimiter };
