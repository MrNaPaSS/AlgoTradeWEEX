const { z } = require('zod');

const csvList = (min = 1) =>
    z
        .string()
        .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean))
        .pipe(z.array(z.string().min(1)).min(min));

const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'silly']).default('debug'),

    TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
    PAPER_STARTING_BALANCE: z.coerce.number().positive().default(10000),
    SHUTDOWN_LIQUIDATE_POSITIONS: z.coerce.boolean().default(false),

    WEEX_API_KEY: z.string().default(''),
    WEEX_SECRET_KEY: z.string().default(''),
    WEEX_PASSPHRASE: z.string().default(''),
    WEEX_REST_URL: z.string().url().default('https://api.weex.com'),
    WEEX_WS_URL: z.string().default('wss://api.weex.com/v2/ws/public'),
    WEEX_WS_PRIVATE_URL: z.string().default('wss://api.weex.com/v2/ws/private'),

    SYMBOLS: csvList(1).default('XAUTUSDT,BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT'),
    TIMEFRAMES: csvList(1).default('10m,1h,1D'),
    DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(125).default(5),

    MAX_POSITION_SIZE_PERCENT: z.coerce.number().positive().max(100).default(5),
    MAX_DAILY_LOSS_PERCENT: z.coerce.number().positive().max(100).default(3),
    MAX_CONCURRENT_POSITIONS: z.coerce.number().int().positive().default(3),
    CORRELATION_VETO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),
    CORRELATION_PENALTY_ENABLED: z.coerce.boolean().default(false),
    TEST_FIXED_NOTIONAL_USD: z.coerce.number().positive().default(10),
    EXCHANGE_MIN_NOTIONAL_USD: z.coerce.number().positive().default(5),
    DEFAULT_SL_ATR_MULT: z.coerce.number().positive().default(3.0),
    DEFAULT_TP1_ATR_MULT: z.coerce.number().positive().default(2.0),
    DEFAULT_TP2_ATR_MULT: z.coerce.number().positive().default(3.0),
    DEFAULT_TP3_ATR_MULT: z.coerce.number().positive().default(6.0),

    // C8 Phase 2: TP ladder close percentages (must sum to 100)
    TP1_CLOSE_PERCENT: z.coerce.number().int().min(1).max(98).default(50),
    TP2_CLOSE_PERCENT: z.coerce.number().int().min(1).max(98).default(30),
    TP3_CLOSE_PERCENT: z.coerce.number().int().min(1).max(98).default(20),
    // How often (ms) to poll exchange for TP fill status (live mode only)
    TP_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(15000),

    // Multi-user
    MASTER_ENCRYPTION_KEY: z.string().default(''),
    MINI_APP_URL: z.string().default(''),

    OPENROUTER_API_KEY: z.string().default(''),
    OPENROUTER_MODEL: z.string().default('anthropic/claude-sonnet-4'),
    OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
    ARBITER_MODE: z.enum(['FAST', 'STANDARD', 'FULL']).default('FULL'),
    ARBITER_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    ARBITER_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(10),

    WEBHOOK_SECRET: z.string().min(8).default('change_me_to_a_long_random_string'),
    WEBHOOK_HMAC_SECRET: z.string().default('change_me_too_for_signature_validation'),
    WEBHOOK_HMAC_REQUIRED: z.coerce.boolean().default(false),
    WEBHOOK_REPLAY_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    WEBHOOK_IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    WEBHOOK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_CHAT_ID: z.string().default(''),

    TWELVEDATA_API_KEY: z.string().default(''),
    FEAR_GREED_API_URL: z.string().url().default('https://api.alternative.me/fng/'),

    METRICS_ENABLED: z
        .string()
        .transform((v) => v === 'true' || v === '1')
        .default('true'),
    METRICS_PATH: z.string().default('/metrics')
})
.superRefine((env, ctx) => {
    // Only enforce HMAC secret quality when the user explicitly enabled HMAC.
    // Do NOT force HMAC_REQUIRED — TradingView alerts work without it.
    if (env.WEBHOOK_HMAC_REQUIRED) {
        const s = env.WEBHOOK_HMAC_SECRET || '';
        if (s.length < 16 || s.includes('change_me')) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['WEBHOOK_HMAC_SECRET'],
                message: 'WEBHOOK_HMAC_SECRET must be ≥ 16 chars when WEBHOOK_HMAC_REQUIRED=true'
            });
        }
    }

    // Live trading still requires WEEX credentials (sanity, not a new restriction).
    if (env.TRADING_MODE === 'live' && (!env.WEEX_API_KEY || !env.WEEX_SECRET_KEY || !env.WEEX_PASSPHRASE)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['WEEX_API_KEY'],
            message: 'WEEX_API_KEY, WEEX_SECRET_KEY, WEEX_PASSPHRASE are required when TRADING_MODE=live'
        });
    }

    // TP split percentages must sum to 100.
    const tpSum = env.TP1_CLOSE_PERCENT + env.TP2_CLOSE_PERCENT + env.TP3_CLOSE_PERCENT;
    if (tpSum !== 100) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['TP1_CLOSE_PERCENT'],
            message: `TP1_CLOSE_PERCENT + TP2_CLOSE_PERCENT + TP3_CLOSE_PERCENT must equal 100, got ${tpSum}`
        });
    }
});

module.exports = { envSchema };
