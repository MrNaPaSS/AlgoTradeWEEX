const express = require('express');
const logger = require('../utils/logger');

/**
 * Admin routes — protected by a shared bearer token. Disabled entirely
 * when `config.admin.enabled` is false (token missing or too short).
 *
 * Routes:
 *   GET  /admin/orphans               — list open positions with user_id IS NULL
 *   POST /admin/orphans/close-all     — close every orphan via master PM
 *
 * "Orphan" = a position row in our DB whose user_id column is NULL. These
 * come from pre-multi-user deployments where the single master PM opened
 * positions before the users table existed. After the subordination fix
 * (commit b6ffd69), master PM hydrates only these rows — the admin routes
 * below are the supported way to wind them down.
 */
function createAdminRouter({ config, positionManager, database } = {}) {
    const router = express.Router();

    if (!config?.admin?.enabled) {
        // Scope the disabled-stub to /admin/* ONLY. Mounted at '/' in app.js,
        // a bare router.use() would intercept EVERY request in the app
        // (including /api/users/me) and 404 the entire app. We want a 404
        // only when someone actually tries to use admin endpoints.
        router.use('/admin', (_req, res) => {
            res.status(404).json({ success: false, error: 'admin routes disabled (ADMIN_TOKEN not configured)' });
        });
        return router;
    }

    const token = config.admin.token;

    // Auth middleware — constant-time compare to resist timing attacks. Accepts
    // either `Authorization: Bearer <token>` or `X-Admin-Token: <token>`.
    router.use((req, res, next) => {
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const header = String(req.headers['x-admin-token'] || '');
        const provided = bearer || header;
        if (!provided || provided.length !== token.length) {
            return res.status(401).json({ success: false, error: 'unauthorized' });
        }
        // Constant-time compare
        let diff = 0;
        for (let i = 0; i < token.length; i++) {
            diff |= token.charCodeAt(i) ^ provided.charCodeAt(i);
        }
        if (diff !== 0) {
            return res.status(401).json({ success: false, error: 'unauthorized' });
        }
        next();
    });

    router.get('/admin/orphans', async (_req, res) => {
        try {
            const rows = await database.getOrphanOpenPositions();
            res.json({
                success: true,
                count: rows.length,
                positions: rows.map((r) => ({
                    positionId: r.position_id,
                    symbol: r.symbol,
                    side: r.side,
                    entryPrice: r.entry_price,
                    remainingQuantity: r.remaining_quantity,
                    openedAt: r.opened_at,
                    status: r.status
                }))
            });
        } catch (err) {
            logger.error('[Admin] list orphans failed', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/admin/orphans/close-all', async (_req, res) => {
        try {
            const before = positionManager.getOpen();
            if (before.length === 0) {
                return res.json({ success: true, closed: 0, message: 'no orphan positions' });
            }
            logger.warn('[Admin] closing all orphan positions via master PM', { count: before.length });
            await positionManager.forceCloseAll('admin_orphan_close');
            const after = positionManager.getOpen();
            res.json({
                success: true,
                closed: before.length - after.length,
                remaining: after.length
            });
        } catch (err) {
            logger.error('[Admin] close-all orphans failed', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = { createAdminRouter };
