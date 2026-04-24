/**
 * Asset-specific precision and step configuration for Weex Futures.
 * Single source of truth — consumed by WeexFuturesClient (rounding),
 * PositionManager (partial-close qty), and sizing math.
 *
 * `price` / `qty` — decimal places for toFixed() formatting.
 * `qtyStep` — minimum quantity increment accepted by the exchange.
 *             Usually 10^-qty, but WEEX enforces larger integer steps
 *             for low-price assets (XRP: 1, ADA: 10) so we carry it
 *             explicitly instead of deriving from `qty`.
 */
const ASSET_PRECISION = {
    'BTCUSDT':  { price: 1, qty: 3, qtyStep: 0.001 },
    'ETHUSDT':  { price: 2, qty: 3, qtyStep: 0.001 },
    'SOLUSDT':  { price: 2, qty: 1, qtyStep: 0.1   },
    'BNBUSDT':  { price: 2, qty: 2, qtyStep: 0.01  },
    'XRPUSDT':  { price: 4, qty: 0, qtyStep: 1     },
    'ADAUSDT':  { price: 4, qty: 0, qtyStep: 10    },
    'XAUTUSDT': { price: 1, qty: 2, qtyStep: 0.01  },
    'DEFAULT':  { price: 2, qty: 3, qtyStep: 0.001 }
};

/**
 * Helper to get precision for a symbol.
 * @param {string} symbol
 * @returns {{price: number, qty: number, qtyStep: number}}
 */
function getAssetPrecision(symbol) {
    return ASSET_PRECISION[symbol] || ASSET_PRECISION.DEFAULT;
}

/**
 * Quantity step (minimum increment) for a symbol. Caller must floor/round
 * quantity to a multiple of this step before submitting to the exchange.
 * @param {string} symbol
 * @returns {number}
 */
function getQtyStep(symbol) {
    return getAssetPrecision(symbol).qtyStep;
}

/**
 * Floor `qty` to the nearest multiple of the symbol's qtyStep. Used for
 * partial-close quantities where over-shooting would cause the exchange
 * to reject with "size exceeds position".
 * @param {string} symbol
 * @param {number} qty
 * @returns {number}
 */
function floorToStep(symbol, qty) {
    const step = getQtyStep(symbol);
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    if (step >= 1) return Math.floor(qty / step) * step;
    // Avoid fp drift: work in integer "ticks".
    const decimals = Math.max(0, Math.round(Math.log10(1 / step)));
    const factor = Math.pow(10, decimals);
    return Math.floor(qty * factor) / factor;
}

module.exports = {
    ASSET_PRECISION,
    getAssetPrecision,
    getQtyStep,
    floorToStep
};
