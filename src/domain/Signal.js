const { nanoid } = require('nanoid');
const { z } = require('zod');

const SIGNAL_TYPES = ['CE_BUY', 'CE_SELL', 'BM_LONG', 'BM_SHORT', 'buy', 'sell', 'long', 'short'];

// TradingView sends {{interval}} as minutes: "1", "5", "60", "240" etc.
// Normalize to internal format: "1m", "5m", "1h", "4h" etc.
const TV_TF_MAP = { '1':'1m','3':'3m','5':'5m','10':'10m','15':'15m','30':'30m',
                    '60':'1h','120':'2h','240':'4h','480':'8h','720':'12h',
                    'D':'1D','1D':'1D','W':'1W','1W':'1W' };
function normalizeTf(tf) {
    return TV_TF_MAP[tf] || tf;
}
const SIGNAL_SOURCES = ['tradingview', 'internal', 'manual', 'backtest'];

const signalSchema = z.object({
    id: z.string().optional(),
    signalId: z.string().optional(),
    source: z.enum(SIGNAL_SOURCES).default('tradingview'),
    signalType: z.enum(SIGNAL_TYPES),
    symbol: z.string().min(1),
    tf: z.string().min(1),
    price: z.coerce.number().positive(),
    longStop:  z.preprocess(v => (v === null ? undefined : v), z.coerce.number().positive().optional()),
    shortStop: z.preprocess(v => (v === null ? undefined : v), z.coerce.number().positive().optional()),
    timestamp: z.coerce.number().int().positive().optional(),
    rsi: z.coerce.number().optional(),
    vo:  z.coerce.number().optional(),
    bmScoreLong:  z.preprocess(v => (v === null ? undefined : v), z.coerce.number().optional()),
    bmScoreShort: z.preprocess(v => (v === null ? undefined : v), z.coerce.number().optional()),
    meta: z.record(z.unknown()).optional()
});

/**
 * Parse + validate a raw webhook payload into a Signal.
 * @param {unknown} payload
 * @returns {import('./types').Signal}
 */
function parseSignal(payload) {
    const parsed = signalSchema.parse(payload);
    let type = parsed.signalType;
    // Normalize standard types
    if (type === 'buy') type = 'BM_LONG';
    if (type === 'sell') type = 'BM_SHORT';
    if (type === 'long') type = 'BM_LONG';
    if (type === 'short') type = 'BM_SHORT';

    return Object.freeze({
        id: parsed.id || parsed.signalId || nanoid(12),
        source: parsed.source,
        signalType: type,
        symbol: parsed.symbol.toUpperCase(),
        tf: normalizeTf(parsed.tf),
        price: parsed.price,
        longStop: parsed.longStop,
        shortStop: parsed.shortStop,
        timestamp: parsed.timestamp || Date.now(),
        rsi: Number.isFinite(parsed.rsi) ? parsed.rsi : undefined,
        vo:  Number.isFinite(parsed.vo)  ? parsed.vo  : undefined,
        bmScoreLong:  Number.isFinite(parsed.bmScoreLong)  ? parsed.bmScoreLong  : undefined,
        bmScoreShort: Number.isFinite(parsed.bmScoreShort) ? parsed.bmScoreShort : undefined,
        meta: Object.freeze(parsed.meta || {})
    });
}

/**
 * Map a signal type to a trading direction.
 * @param {string} signalType
 * @returns {'LONG'|'SHORT'}
 */
function signalDirection(signalType) {
    const t = signalType.toLowerCase();
    if (t.includes('buy') || t.includes('long')) return 'LONG';
    if (t.includes('sell') || t.includes('short')) return 'SHORT';
    throw new Error(`[Signal] unknown signalType: ${signalType}`);
}

module.exports = { parseSignal, signalDirection, SIGNAL_TYPES, SIGNAL_SOURCES, signalSchema };
