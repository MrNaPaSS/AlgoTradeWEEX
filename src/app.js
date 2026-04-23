require('dotenv').config();

const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');
const requestId = require('./middleware/requestId');
const { webhookRateLimiter } = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');

const { Database } = require('./services/database');
const { WeexFuturesClient } = require('./api/weex/WeexFuturesClient');
const { WeexWebSocket } = require('./api/weex/WeexWebSocket');
const { Container } = require('./container');

// Import all services
const { DataAggregator } = require('./services/dataAggregator');
const { IndicatorEngine } = require('./services/indicatorEngine');
const { RiskGuard } = require('./services/riskGuard');
const { PositionManager } = require('./services/positionManager');
const { TradingOrchestrator } = require('./services/tradingOrchestrator');
const { LiveBroker } = require('./services/liveBroker');
const { PaperBroker } = require('./services/paperBroker');
const { OpenRouterClient } = require('./llm/OpenRouterClient');
const { Arbiter } = require('./agents/Arbiter');
const telegram = require('./services/telegram');

// Import all agents
const { TechnicalAgent } = require('./agents/TechnicalAgent');
const { BlackMirrorAgent } = require('./agents/BlackMirrorAgent');
const { ChandelierAgent } = require('./agents/ChandelierAgent');
const { SentimentAgent } = require('./agents/SentimentAgent');
const { RiskAgent } = require('./agents/RiskAgent');

const { UserTradeEngine } = require('./services/userTradeEngine');
const { createUsersRouter } = require('./routes/users');
const telegramAuth = require('./middleware/telegramAuth');
const { apiLimiter, registerLimiter } = require('./middleware/userRateLimit');

const { createWebhookRouter } = require('./routes/webhook');
const { createHealthRouter } = require('./routes/health');
const { createMetricsRouter, metrics: promMetrics } = require('./routes/metrics');

async function bootstrap() {
    // ── Live-mode startup guards: fail fast before touching exchange ──────────
    if (config.trading?.mode === 'live') {
        const missing = [];
        if (!config.weex.apiKey) missing.push('WEEX_API_KEY');
        if (!config.weex.secretKey) missing.push('WEEX_SECRET_KEY');
        if (!config.weex.passphrase) missing.push('WEEX_PASSPHRASE');
        if (missing.length) {
            throw new Error(`[App] TRADING_MODE=live but missing credentials: ${missing.join(', ')}`);
        }
        if (!config.webhook.hmacRequired && config.isProd) {
            logger.warn('[App] LIVE mode in production without WEBHOOK_HMAC_REQUIRED=true — attack surface is wide open');
        }
    }

    // ── DI Container ──────────────────────────────────────────────────────────
    const container = new Container();

    // 1. Infrastructure
    const db = new Database();
    await db.init();
    container.registerValue('db', db);



    const weexClient = new WeexFuturesClient({
        apiKey:     config.weex.apiKey,
        secretKey:  config.weex.secretKey,
        passphrase: config.weex.passphrase,
        onEvent: (event, payload) => {
            if (event === 'circuitOpen') {
                logger.error('[App] WEEX REST Circuit OPEN', payload);
                telegram.sendMessage?.(`🔴 *CRITICAL: WEEX API Circuit Open*\nService: ${payload.name}\nREST calls are temporarily disabled.`).catch(() => {});
            } else if (event === 'circuitClosed') {
                logger.info('[App] WEEX REST Circuit CLOSED', payload);
                telegram.sendMessage?.('🟢 *WEEX API Circuit Recovered*').catch(() => {});
            }
        }
    });
    container.registerValue('weexClient', weexClient);

    const weexWs = new WeexWebSocket();
    container.registerValue('weexWs', weexWs);

    const openRouter = new OpenRouterClient({
        apiKey: config.openRouter.apiKey,
        model: config.openRouter.model,
        timeoutMs: config.arbiter?.llmTimeoutMs,
        cacheTtlSeconds: config.arbiter?.cacheTtlSeconds,
        onMetric: (event, data = {}) => {
            if (event === 'llm_success' && Number.isFinite(data.durationMs)) {
                promMetrics.llmDurationMs.labels(config.openRouter.model || 'unknown').observe(data.durationMs);
            } else if (event === 'llm_error') {
                promMetrics.llmErrorsTotal.labels(String(!!data.transient)).inc();
            }
        }
    });
    container.registerValue('llm', openRouter);

    // 2. Services
    const dataAggregator = new DataAggregator();
    const indicatorEngine = new IndicatorEngine();
    
    // Broker Setup
    const isLive = config.trading?.mode === 'live';
    const broker = isLive
        ? new LiveBroker({ client: weexClient })
        : new PaperBroker({ startingBalanceUsd: config.trading.paperStartingBalance });
    
    // Balance fetching wrapper for RiskAgent
    const getAvailableBalanceUsd = async () => {
        if (isLive) return broker.getAvailableBalanceUsd();
        return broker.getAvailableBalanceUsd(); // PaperBroker has this too
    };


    const riskGuard = new RiskGuard({
        database: db,
        config: config.risk,
        metrics: promMetrics,
        getAvailableBalanceUsd,
        getOpenPositions: () => positionManager.getOpen(),
        onEvent: (event, payload) => {
            if (event === 'paused') {
                logger.warn('[App] RiskGuard PAUSED trading', payload);
                telegram.sendMessage?.(`⚠️ *Trading Paused (RiskGuard)*\nReason: ${payload.reason}`).catch(() => {});
            } else if (event === 'resumed') {
                logger.info('[App] RiskGuard RESUMED trading');
                telegram.sendMessage?.('🟢 *Trading Resumed (RiskGuard)*').catch(() => {});
            }
        }
    });
    await riskGuard.init();

    const positionManager = new PositionManager({
        database: db,
        broker,
        config,
        riskGuard,
        minNotionalUsd: config.risk?.exchangeMinNotionalUsd,
        onEvent: (event, payload) => {
            logger.info(`[PositionManager] ${event}`, payload);
            if (event === 'positionOpened' && payload?.position) {
                promMetrics.ordersTotal.labels(payload.position.symbol, payload.position.side, payload.position.mode || 'unknown').inc();
                telegram.notifyPositionOpened?.(payload.position).catch(() => {});
            } else if (event === 'positionClosed' && payload?.position) {
                telegram.notifyPositionClosed?.(payload.position, payload.reason, payload.pnl).catch(() => {});
            } else if (event === 'partialClose' && payload?.position) {
                telegram.notifyTakeProfitHit?.(payload.position, payload.level, payload.pnl).catch(() => {});
            } else if (event === 'openFailed') {
                const reasonTag = /min(imum)?\s*notional/i.test(String(payload?.reason || '')) ? 'min_notional' : 'exchange_error';
                promMetrics.ordersFailedTotal.labels(payload?.symbol || 'unknown', reasonTag).inc();
                telegram.notifyError?.(`⚠️ Order failed on ${payload?.symbol}: ${payload?.reason}`).catch(() => {});
            }
        }
    });

    // Sync positions from exchange to catch up with any missed events
    if (isLive) {
        await positionManager.syncWithExchange();
        // C8 Phase 2: Start polling for exchange TP fills
        positionManager.startTpPolling();
    }

    // 3. Agents
    const arbiter = new Arbiter({
        llm: openRouter,
        mode: 'FAST',
        consensusThreshold: 1
    });

    const technicalAgent = new TechnicalAgent();
    const blackMirrorAgent = new BlackMirrorAgent();
    const chandelierAgent = new ChandelierAgent();
    const sentimentAgent = new SentimentAgent();
    const riskAgent = new RiskAgent({
        riskGuard,
        riskConfig: config.risk,
        getAvailableBalanceUsd
    });

    const tradingAgents = [technicalAgent, blackMirrorAgent, chandelierAgent, sentimentAgent];

    // 4. Orchestrator
    const orchestrator = new TradingOrchestrator({
        dataAggregator,
        indicatorEngine,
        tradingAgents,
        riskAgent,
        arbiter,
        positionManager,
        database: db,
        riskGuard,
        weexClient: weexClient,
        config,
        onEvent: (event, payload) => {
            if (event === 'decisionMade') {
                logger.info('[Orchestrator] Decision made', { direction: payload.decision.direction, symbol: payload.decision.symbol });
            }
        }
    });

    telegram.initialize(orchestrator);
    container.registerValue('telegram', telegram);

    // ── Multi-User Engine ─────────────────────────────────────────────────────
    const userTradeEngine = new UserTradeEngine({
        database: db,
        telegram,
        config,
        metrics: promMetrics
    });
    // Wire into orchestrator so fanOut works on signals
    orchestrator._userTradeEngine = userTradeEngine;

    // Load all active users (boots isolated broker/risk/pm per user)
    await userTradeEngine.loadAllUsers();

    // ── WebSocket ─────────────────────────────────────────────────────────────
    const symbols = config.trading?.symbols || ['BTCUSDT', 'XAUTUSDT'];
    const tfs = config.trading?.timeframes || ['1h'];

    weexWs.on('kline', ({ symbol, tf, candle }) => {
        // Feed real-time data into aggregator
        dataAggregator.pushCandle(symbol, tf, candle);
        // Feed into orchestrator for TP/SL tracking
        orchestrator.onCandleClosed({ symbol, candle });
    });
    // Real-time mark price → immediate TP/SL evaluation (critical on 1h TF)
    weexWs.on('ticker', ({ symbol, data }) => {
        const price = Number(
            data?.last ?? data?.c ?? data?.close ?? data?.markPrice ?? data?.lastPrice
        );
        if (!Number.isFinite(price) || price <= 0) return;
        // Master user
        positionManager.onMarkPrice(symbol, price).catch((err) =>
            logger.warn('[WS] onMarkPrice failed', { symbol, message: err.message })
        );
        // Mini-app users
        userTradeEngine.onMarkPrice(symbol, price).catch(() => {});
    });
    weexWs.on('error', (err) => logger.warn('[WS] error', { message: err.message }));
    weexWs.on('close', () => {
        promMetrics.wsReconnectsTotal.inc();
        promMetrics.wsConnectedGauge.set(0);
    });
    weexWs.on('open', () => {
        for (const sym of symbols) {
            for (const tf of tfs) {
                weexWs.subscribeKline(sym, tf);
            }
            // Subscribe once per symbol for tick-level mark price
            weexWs.subscribeTicker?.(sym);
        }
    });
    logger.info('[App] WS connecting...');
    weexWs.connect();

    // ── Express App ───────────────────────────────────────────────────────────
    const app = express();
    app.set('trust proxy', 1);
    app.set('db', db);

    app.use(requestId);

    // CORS for Mini App hosted on a separate origin (render.com static site).
    // MINI_APP_ORIGIN is a comma-separated list of allowed origins (e.g.
    // "https://algotradeweex.onrender.com,http://localhost:8080"). Leave empty
    // to fall back to a permissive policy suitable for dev.
    const corsAllow = (process.env.MINI_APP_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    app.use('/api', (req, res, next) => {
        const origin = req.headers.origin;
        if (!origin) return next();
        const allowed = corsAllow.length === 0 || corsAllow.includes(origin);
        if (allowed) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
            res.setHeader('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);
        next();
    });

    // Routes (rate-limit applies ONLY to /webhook, not /health or /metrics)
    app.use('/', createHealthRouter({ db, weexWs, weexClient }));
    app.use('/', createMetricsRouter({ weexWs }));
    // Mini App static files
    app.use('/mini-app', express.static('public/mini-app'));

    // User API (Telegram Mini App)
    // registerLimiter is passed into the router so it wraps POST /register before apiLimiter
    const usersRouter = createUsersRouter({ userTradeEngine, db, telegram, registerLimiter });
    app.use('/api/users', telegramAuth, apiLimiter, usersRouter);

    app.use('/webhook', webhookRateLimiter, createWebhookRouter({
        orchestrator,
        telegram,
        metrics: {
            incWebhookDuplicate: () => promMetrics.webhookDuplicatesTotal.inc()
        }
    }));

    // Root info
    app.get('/', (_req, res) => res.json({
        name: 'AlgoTrade Pro',
        version: '2.0.0',
        mode: config.trading?.mode || 'paper',
        endpoints: {
            webhook: 'POST /webhook',
            health:  'GET /health',
            ready:   'GET /ready',
            metrics: 'GET /metrics'
        }
    }));

    app.use(errorHandler);

    // ── Start ─────────────────────────────────────────────────────────────────
    const PORT = config.server.port;
    const server = app.listen(PORT, () => {
        logger.info('══════════════════════════════════');
        logger.info('  AlgoTrade Pro v2.0.0 started   ');
        logger.info('══════════════════════════════════');
        logger.info(`Port:    ${PORT}`);
        logger.info(`Mode:    ${config.trading?.mode || 'paper'}`);
        logger.info(`Symbols: ${symbols.join(', ')}`);
        logger.info(`TFs:     ${tfs.join(', ')}`);
        logger.info('══════════════════════════════════');

        telegram.sendMessage?.(`🟢 *AlgoTrade Pro v2 запущен*\nРежим: *${(config.trading?.mode || 'paper').toUpperCase()}*`)
            .then(() => logger.info('[Telegram] Startup message sent'))
            .catch((err) => logger.error('[Telegram] Startup message failed', { message: err.message }));
    });

    // ── Graceful Shutdown ─────────────────────────────────────────────────────
    let shuttingDown = false;
    async function shutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[App] ${signal} received — draining`);
        telegram.sendMessage?.(`🟡 Shutdown (${signal}) — draining in-flight requests`).catch(() => {});

        // Stop accepting new HTTP (existing keep-alive drains naturally).
        const drainDeadline = Date.now() + 15_000;
        await new Promise((resolve) => {
            server.close(() => resolve());
            setTimeout(() => resolve(), Math.max(0, drainDeadline - Date.now()));
        });

        try {
            if (config.trading.mode === 'live' && config.trading.shutdownLiquidatePositions) {
                const openPositions = positionManager.getOpen();
                if (openPositions.length > 0) {
                    logger.warn(`[App] Liquidating ${openPositions.length} positions before shutdown`);
                    telegram.sendMessage?.(`⚠️ *Shutdown* — liquidating ${openPositions.length} positions as per policy`).catch(() => {});
                    await positionManager.forceCloseAll('SHUTDOWN');
                }
            }
            orchestrator.dispose?.();
            positionManager.stopTpPolling?.();
            // Stop all user engines
            for (const uid of userTradeEngine.getAllActiveUserIds()) {
                await userTradeEngine.removeUser(uid).catch(() => {});
            }
            weexWs.close();
            await db.close();
            container.dispose();
        } catch (err) {
            logger.error('[App] shutdown error', { message: err.message });
        }
        telegram.sendMessage?.('🔴 Shutdown complete').catch(() => {});
        process.exit(0);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
        logger.error('[App] uncaughtException', { message: err.message, stack: err.stack });
        telegram.notifyError?.(`🔴 CRITICAL: ${err.message}`).catch(() => {});
    });
    process.on('unhandledRejection', (reason) => {
        logger.error('[App] unhandledRejection', { reason: String(reason) });
    });

    return app;
}

bootstrap().catch((err) => {
    console.error('[App] bootstrap failed:', err);
    process.exit(1);
});
