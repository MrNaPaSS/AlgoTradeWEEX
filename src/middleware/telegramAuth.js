const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Telegram Mini App initData verification middleware.
 *
 * Telegram signs initData with HMAC-SHA256 using a key derived from the bot token.
 * This middleware validates that signature and extracts the user object.
 *
 * Usage: app.use('/api/users', telegramAuth, router)
 *
 * After this middleware, req.telegramUser contains:
 *   { id, first_name, last_name?, username? }
 */
function telegramAuth(req, res, next) {
    // Accept initData from Authorization header or query param
    const authHeader = req.headers['authorization'] || '';
    let initData = '';

    if (authHeader.startsWith('tma ')) {
        initData = authHeader.slice(4);
    } else if (req.query?.initData) {
        initData = req.query.initData;
    }

    if (!initData) {
        return res.status(401).json({ success: false, error: 'Missing Telegram initData' });
    }

    const botToken = config.telegram.botToken;
    if (!botToken) {
        logger.error('[telegramAuth] TELEGRAM_BOT_TOKEN not configured');
        return res.status(500).json({ success: false, error: 'Bot token not configured' });
    }

    try {
        const parsed = validateInitData(initData, botToken);
        if (!parsed) {
            return res.status(401).json({ success: false, error: 'Invalid initData signature' });
        }

        // Check auth_date freshness (24 hours max)
        const authDate = parsed.auth_date ? Number(parsed.auth_date) : 0;
        const now = Math.floor(Date.now() / 1000);
        if (now - authDate > 86400) {
            return res.status(401).json({ success: false, error: 'initData expired (>24h)' });
        }

        // Parse user JSON
        let user;
        try {
            user = JSON.parse(parsed.user);
        } catch {
            return res.status(401).json({ success: false, error: 'Invalid user in initData' });
        }

        if (!user?.id) {
            return res.status(401).json({ success: false, error: 'No user id in initData' });
        }

        req.telegramUser = {
            id: String(user.id),
            first_name: user.first_name || '',
            last_name: user.last_name || '',
            username: user.username || ''
        };

        next();
    } catch (err) {
        logger.error('[telegramAuth] verification error', { message: err.message });
        return res.status(401).json({ success: false, error: 'initData verification failed' });
    }
}

/**
 * Validate Telegram WebApp initData using HMAC-SHA256.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * @param {string} initData - URL-encoded initData string
 * @param {string} botToken
 * @returns {Object|null} parsed params if valid, null if invalid
 */
function validateInitData(initData, botToken) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;

    // Remove hash from params and sort alphabetically
    params.delete('hash');
    const entries = Array.from(params.entries());
    entries.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    // HMAC key = HMAC-SHA256("WebAppData", botToken)
    const secretKey = crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();

    const computedHash = crypto
        .createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    // Constant-time comparison
    try {
        const a = Buffer.from(computedHash);
        const b = Buffer.from(hash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return null;
        }
    } catch {
        return null;
    }

    // Return all parsed params as object
    const result = {};
    for (const [k, v] of new URLSearchParams(initData)) {
        result[k] = v;
    }
    return result;
}

module.exports = telegramAuth;
