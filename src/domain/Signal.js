const { nanoid } = require('nanoid');
const { z } = require('zod');

const SIGNAL_TYPES = ['CE_BUY', 'CE_SELL', 'BM_LONG', 'BM_SHORT', 'buy', 'sell', 'long', 'short'];
const SIGNAL_SOURCES = ['tradingview', 'internal', 'manual', 'backtest'];

const signalSchema = z.object({
    id: z.string().optional(),
    signalId: z.string().optional(),
    source: z.enum(SIGNAL_SOURCES).default('tradingview'),
    signalType: z.enum(SIGNAL_TYPES),
    symbol: z.string().min(1),
    tf: z.string().min(1),
    price: z.coerce.number().positive(),
    longStop: z.coerce.number().positive().optional(),
    shortStop: z.coerce.number().positive().optional(),
    timestamp: z.coerce.number().int().positive().optional(),
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
        tf: parsed.tf,
        price: parsed.price,
        longStop: parsed.longStop,
        shortStop: parsed.shortStop,
        timestamp: parsed.timestamp || Date.now(),
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
