require('dotenv').config();

const path = require('path');
const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');

const { createDatabase } = require('./services/createDatabase');
const { UserTradeEngine } = require('./services/userTradeEngine');
const { TelegramSendOnly } = require('./services/telegramSendOnly');
const { createUsersRouter } = require('./routes/users');
const telegramAuth = require('./middleware/telegramAuth');
const { apiLimiter, registerLimiter } = require('./middleware/userRateLimit');

/**
 * src/web.js — lightweight entry point for render.com (or any read-only host).
 *
 * Responsibilities:
 *   - HTTP server for the Telegram Mini App static bundle (`/mini-app/*`)
 *   - REST API under `/api/users/*` (profile, risk, symbols, pause/resume, emergency close)
 *   - Health/info endpoints (`/health`, `/`)
 *
 * NOT included (handled by src/app.js on the remote VPS):
 *   - Telegram bot polling
 *   - WEEX WebSocket
 *   - Orchestrator / agents / indicator pipeline
 *   - Webhook intake
 *
 * Both entry points share the same PostgreSQL database via `DATABASE_URL`
 * so the Mini App sees live state that the VPS bot writes.
 */

async function bootstrap() {
    const db = createDatabase();
    await db.init();

    const telegram = new TelegramSendOnly();

    // UserTradeEngine is used here purely for read-only views (status, positions,
    // balance) and for spinning up per-user brokers when a new user registers.
    // The VPS side runs the fan-out; this side never executes trades autonomously.
    const userTradeEngine = new UserTradeEngine({
        database: db,
        telegram,
        config,
        metrics: null
    });

    try {
        await userTradeEngine.loadAllUsers();
    } catch (err) {
        logger.error('[web] loadAllUsers failed — continuing with empty engine', { message: err.message });
    }

    const app = express();
    app.set('trust proxy', 1);
    app.set('db', db);

    app.use(requestId);

    // Static mini-app bundle
    app.use('/mini-app', express.static(path.join(__dirname, '..', 'public', 'mini-app')));

    // Mini App REST API — Telegram-auth protected, per-user rate limited.
    const usersRouter = createUsersRouter({
        userTradeEngine,
        db,
        telegram,
        registerLimiter
    });
    app.use('/api/users', telegramAuth, apiLimiter, usersRouter);

    // Health / info
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            role: 'web',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime())
        });
    });

    app.get('/', (_req, res) => {
        res.json({
            name: 'AlgoTrade Pro Web',
            version: '2.0.0',
            role: 'web (mini-app + users API)',
            endpoints: {
                miniApp:   'GET  /mini-app/*',
                health:    'GET  /health',
                users:     '/api/users/* (Telegram-auth)'
            }
        });
    });

    app.use(errorHandler);

    const port = Number(process.env.PORT) || config.server.port || 3000;
    const server = app.listen(port, () => {
        logger.info('══════════════════════════════════');
        logger.info('  AlgoTrade Pro Web started       ');
        logger.info('══════════════════════════════════');
        logger.info(`Port:   ${port}`);
        logger.info(`DB:     ${process.env.DATABASE_URL ? 'PostgreSQL (DATABASE_URL)' : 'sql.js (local)'}`);
        logger.info(`Users:  ${userTradeEngine.getAllActiveUserIds().length}`);
        logger.info('══════════════════════════════════');
    });

    // ── Graceful shutdown ─────────────────────────────────────────────────
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[web] ${signal} received — draining`);
        await new Promise((resolve) => {
            server.close(() => resolve());
            setTimeout(resolve, 10_000);
        });
        try {
            for (const uid of userTradeEngine.getAllActiveUserIds()) {
                await userTradeEngine.removeUser(uid).catch(() => {});
            }
            await db.close();
        } catch (err) {
            logger.error('[web] shutdown error', { message: err.message });
        }
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
        logger.error('[web] unhandledRejection', { reason: String(reason) });
    });
}

bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[web] bootstrap failed:', err);
    process.exit(1);
});
