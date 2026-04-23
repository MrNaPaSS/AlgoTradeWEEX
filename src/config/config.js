require('dotenv').config();

const { envSchema } = require('./schema');

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
    throw new Error(`[config] Invalid environment variables:\n${issues}`);
}

const env = parsed.data;

const config = Object.freeze({
    env: env.NODE_ENV,
    isDev: env.NODE_ENV === 'development',
    isTest: env.NODE_ENV === 'test',
    isProd: env.NODE_ENV === 'production',

    server: Object.freeze({
        port: env.PORT,
        logLevel: env.LOG_LEVEL
    }),

    trading: Object.freeze({
        mode: env.TRADING_MODE,
        paperStartingBalance: env.PAPER_STARTING_BALANCE,
        symbols: Object.freeze([...env.SYMBOLS]),
        timeframes: Object.freeze([...env.TIMEFRAMES]),
        defaultLeverage: env.DEFAULT_LEVERAGE,
        shutdownLiquidatePositions: env.SHUTDOWN_LIQUIDATE_POSITIONS
    }),

    risk: Object.freeze({
        maxPositionSizePercent: env.MAX_POSITION_SIZE_PERCENT,
        maxDailyLossPercent: env.MAX_DAILY_LOSS_PERCENT,
        maxConcurrentPositions: env.MAX_CONCURRENT_POSITIONS,
        correlationVetoThreshold: env.CORRELATION_VETO_THRESHOLD,
        correlationPenaltyEnabled: env.CORRELATION_PENALTY_ENABLED,
        testFixedNotionalUsd: env.TEST_FIXED_NOTIONAL_USD,
        exchangeMinNotionalUsd: env.EXCHANGE_MIN_NOTIONAL_USD,
        slAtrMult: env.DEFAULT_SL_ATR_MULT,
        tp1AtrMult: env.DEFAULT_TP1_ATR_MULT,
        tp2AtrMult: env.DEFAULT_TP2_ATR_MULT,
        tp3AtrMult: env.DEFAULT_TP3_ATR_MULT,
        tp1ClosePercent: env.TP1_CLOSE_PERCENT,
        tp2ClosePercent: env.TP2_CLOSE_PERCENT,
        tp3ClosePercent: env.TP3_CLOSE_PERCENT,
        tpPollIntervalMs: env.TP_POLL_INTERVAL_MS
    }),

    weex: Object.freeze({
        apiKey: env.WEEX_API_KEY,
        secretKey: env.WEEX_SECRET_KEY,
        passphrase: env.WEEX_PASSPHRASE,
        restUrl: env.WEEX_REST_URL,
        wsUrl: env.WEEX_WS_URL,
        wsPrivateUrl: env.WEEX_WS_PRIVATE_URL,
        isConfigured: Boolean(env.WEEX_API_KEY && env.WEEX_SECRET_KEY && env.WEEX_PASSPHRASE)
    }),

    arbiter: Object.freeze({
        mode: env.ARBITER_MODE,
        llmTimeoutMs: env.ARBITER_LLM_TIMEOUT_MS,
        cacheTtlSeconds: env.ARBITER_CACHE_TTL_SECONDS
    }),

    openRouter: Object.freeze({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        baseUrl: env.OPENROUTER_BASE_URL,
        isConfigured: Boolean(env.OPENROUTER_API_KEY)
    }),

    webhook: Object.freeze({
        secret: env.WEBHOOK_SECRET,
        hmacSecret: env.WEBHOOK_HMAC_SECRET,
        hmacRequired: env.WEBHOOK_HMAC_REQUIRED,
        replayWindowSeconds: env.WEBHOOK_REPLAY_WINDOW_SECONDS,
        idempotencyTtlSeconds: env.WEBHOOK_IDEMPOTENCY_TTL_SECONDS,
        rateLimitPerMinute: env.WEBHOOK_RATE_LIMIT_PER_MINUTE
    }),

    telegram: Object.freeze({
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
        isConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    }),

    external: Object.freeze({
        twelveDataKey: env.TWELVEDATA_API_KEY,
        fearGreedUrl: env.FEAR_GREED_API_URL
    }),

    multiUser: Object.freeze({
        masterEncryptionKey: env.MASTER_ENCRYPTION_KEY,
        miniAppUrl: env.MINI_APP_URL
    }),

    metrics: Object.freeze({
        enabled: env.METRICS_ENABLED,
        path: env.METRICS_PATH
    })
});

module.exports = config;
