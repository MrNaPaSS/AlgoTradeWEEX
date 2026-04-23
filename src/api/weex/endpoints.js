/**
 * WEEX Futures (USDT-M Perpetual) REST & WebSocket endpoint catalog.
 *
 * Based on official WEEX API documentation:
 * https://www.weex.com/api-doc/spot/introduction/APIBriefIntroduction
 *
 * REST Base URL:       https://api-contract.weex.com
 * WS Public URL:       wss://ws-contract.weex.com/v3/ws/public
 * WS Private URL:      wss://ws-contract.weex.com/v3/ws/private
 *
 * NOTE: Endpoint paths start with /capi/v3/ (futures), NOT /api/mix/v1/
 */

const BASE_URL_REST    = 'https://api-contract.weex.com';
const BASE_URL_WS_PUB  = 'wss://ws-contract.weex.com/v3/ws/public';
const BASE_URL_WS_PRIV = 'wss://ws-contract.weex.com/v3/ws/private';

const ENDPOINTS = Object.freeze({
    account: Object.freeze({
        /** GET /capi/v3/account/balance — futures USDT balance */
        balance:      '/capi/v3/account/balance',
        /** GET /capi/v3/account/position/allPosition — all open positions */
        positions:    '/capi/v3/account/position/allPosition',
        /** POST /capi/v3/account/leverage — set leverage */
        setLeverage:  '/capi/v3/account/leverage',
        /** GET /capi/v3/account/commissionRate */
        commission:   '/capi/v3/account/commissionRate'
    }),
    order: Object.freeze({
        /** POST /capi/v3/order — place new order (supports tpTriggerPrice, slTriggerPrice) */
        place:        '/capi/v3/order',
        /** DELETE /capi/v3/order — cancel order */
        cancel:       '/capi/v3/order',
        /** GET /capi/v3/order — query order status */
        query:        '/capi/v3/order',
        /** GET /capi/v3/openOrders — list open orders */
        openOrders:   '/capi/v3/openOrders',
        /** GET /capi/v3/openAlgoOrders — list active conditional (plan) orders */
        openAlgoOrders: '/capi/v3/openAlgoOrders',
        /** DELETE /capi/v3/algoOpenOrders — cancel all conditional (plan) orders */
        cancelAllAlgo: '/capi/v3/algoOpenOrders',
        /** GET /capi/v3/allOrders — historical orders */
        allOrders:    '/capi/v3/allOrders',
        /** POST/DELETE /capi/v3/algoOrder — place or cancel a single conditional order */
        algoOrder:    '/capi/v3/algoOrder',
        /** POST /capi/v3/placeTpSlOrder — place specialized TP/SL order */
        tpSlOrder:    '/capi/v3/placeTpSlOrder',
        /** POST /capi/v3/modifyTpSlOrder — ATOMIC modify for TP/SL (V3 confirmed) */
        modifyTpSl:   '/capi/v3/modifyTpSlOrder'
    }),
    market: Object.freeze({
        /** GET /capi/v3/market/klines — candlestick data */
        klines:       '/capi/v3/market/klines',
        /** GET /capi/v3/market/ticker/24hr — 24h stats & last price */
        ticker:       '/capi/v3/market/ticker/24hr',
        /** GET /capi/v3/market/ticker/24hr — all symbols stats */
        tickers:      '/capi/v3/market/ticker/24hr',
        /** GET /capi/v3/market/depth — order book */
        depth:        '/capi/v3/market/depth',
        /** GET /capi/v3/market/exchangeInfo — symbol info & precision */
        exchangeInfo: '/capi/v3/market/exchangeInfo',
        /** GET /capi/v3/market/time — server time health check */
        time:         '/capi/v3/market/time'
    })
});

/**
 * Order side values per WEEX API:
 *   BUY  — open long / close short
 *   SELL — open short / close long
 */
const SIDE = Object.freeze({ BUY: 'BUY', SELL: 'SELL' });

/**
 * positionSide values (hedge mode):
 *   LONG  — long position
 *   SHORT — short position
 */
const POSITION_SIDE = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });

/**
 * Order types:
 *   MARKET — market order (no price required)
 *   LIMIT  — limit order (price required)
 */
const ORDER_TYPE = Object.freeze({ MARKET: 'MARKET', LIMIT: 'LIMIT' });

/**
 * Kline intervals accepted by REST /capi/v3/market/klines and WS channel.
 * REST param: interval=1m | 5m | 15m | 1h | 4h | 1d | 1w
 * WS channel:  symbol@kline_1m | symbol@kline_1h | ...
 */
const INTERVALS = Object.freeze({
    '1m':  '1m',
    '5m':  '5m',
    '10m': '15m',   // WEEX does NOT have 10m — nearest is 15m; override if needed
    '15m': '15m',
    '30m': '30m',
    '1h':  '1h',
    '4h':  '4h',
    '1D':  '1d',
    '1W':  '1w'
});

/**
 * Convert internal timeframe string to WEEX REST interval string.
 * @param {string} tf — e.g. '1h', '10m', '1D'
 * @returns {string} — e.g. '1h', '15m', '1d'
 */
function toInterval(tf) {
    const val = INTERVALS[tf];
    if (!val) throw new Error(`[weex] unsupported timeframe: ${tf}`);
    return val;
}

/**
 * Build WebSocket kline channel name.
 * Format: <SYMBOL>@kline_<interval>  e.g. BTCUSDT@kline_1h
 * @param {string} symbol — e.g. 'BTCUSDT'
 * @param {string} tf     — e.g. '1h'
 */
function toKlineChannel(symbol, tf) {
    return `${symbol.toUpperCase()}@kline_${toInterval(tf)}`;
}

module.exports = {
    BASE_URL_REST,
    BASE_URL_WS_PUB,
    BASE_URL_WS_PRIV,
    ENDPOINTS,
    SIDE,
    POSITION_SIDE,
    ORDER_TYPE,
    toInterval,
    toKlineChannel
};
