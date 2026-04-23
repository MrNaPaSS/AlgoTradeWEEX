/**
 * Asset-specific precision and step configuration for Weex Futures.
 * Maps symbols to their price and quantity decimal places.
 */
const ASSET_PRECISION = {
    'BTCUSDT': { price: 1, qty: 3 },
    'ETHUSDT': { price: 2, qty: 3 },
    'SOLUSDT': { price: 2, qty: 1 },
    'BNBUSDT': { price: 2, qty: 2 },
    'XRPUSDT': { price: 4, qty: 1 },
    'ADAUSDT': { price: 4, qty: 1 },
    'XAUTUSDT': { price: 1, qty: 3 },
    'DEFAULT': { price: 2, qty: 3 }
};

/**
 * Helper to get precision for a symbol.
 * @param {string} symbol 
 * @returns {{price: number, qty: number}}
 */
function getAssetPrecision(symbol) {
    return ASSET_PRECISION[symbol] || ASSET_PRECISION.DEFAULT;
}

module.exports = {
    ASSET_PRECISION,
    getAssetPrecision
};
