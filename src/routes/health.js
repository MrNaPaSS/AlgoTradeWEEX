const express = require('express');

/**
 * Health & Readiness routes.
 *
 * GET /health  — liveness probe (always 200 if process is up)
 * GET /ready   — readiness probe (DB ping, WEEX WS connectivity, optional REST reachability)
 */
function createHealthRouter({ db, weexWs, weexClient } = {}) {
    const router = express.Router();

    router.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime())
        });
    });

    router.get('/ready', async (_req, res) => {
        const checks = {};
        let allOk = true;

        // DB check — wrapped in timeout so a locked sql.js cannot wedge /ready.
        try {
            if (db && typeof db.get === 'function') {
                const dbProbe = (async () => {
                    await db.get('SELECT 1 AS ping');
                    await db.get('SELECT COUNT(*) AS n FROM positions');
                    return true;
                })();
                await Promise.race([
                    dbProbe,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('db probe timeout')), 2000))
                ]);
                checks.database = 'ok';
            } else {
                checks.database = 'unavailable';
                allOk = false;
            }
        } catch (err) {
            checks.database = `error: ${err.message}`;
            allOk = false;
        }

        // WebSocket check
        if (weexWs) {
            const wsState = weexWs._ws?.readyState;
            checks.weexWebSocket = wsState === 1 ? 'connected' : 'disconnected';
            if (wsState !== 1) allOk = false;
        } else {
            checks.weexWebSocket = 'not_configured';
        }

        // REST reachability (non-fatal — only warn if broken)
        if (weexClient && typeof weexClient.ping === 'function') {
            try {
                await Promise.race([
                    weexClient.ping(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('rest timeout')), 2500))
                ]);
                checks.weexRest = 'ok';
            } catch (err) {
                checks.weexRest = `degraded: ${err.message}`;
                // REST degradation does NOT fail readiness — WS is the primary data path
            }
        }

        const status = allOk ? 200 : 503;
        res.status(status).json({
            ready: allOk,
            checks,
            timestamp: new Date().toISOString()
        });
    });

    return router;
}

module.exports = { createHealthRouter };
