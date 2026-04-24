const https = require('https');
const axios = require('axios');

const { WeexSignature } = require('./signature');
const {
    BASE_URL_REST,
    ENDPOINTS,
    SIDE,
    POSITION_SIDE,
    ORDER_TYPE,
    toInterval
} = require('./endpoints');
const { createBreaker } = require('../../utils/circuitBreaker');
const { withRetry } = require('../../utils/retry');
const logger = require('../../utils/logger');
const { getAssetPrecision } = require('../../config/assets');

class WeexApiError extends Error {
    constructor(message, { code, status, path, payload } = {}) {
        super(message);
        this.name = 'WeexApiError';
        this.code = code;
        this.status = status;
        this.path = path;
        this.payload = payload;
    }
}

/**
 * WEEX Futures REST client.
 *
 * Based on official docs: https://www.weex.com/api-doc
 * Base URL:  https://api-contract.weex.com
 * Auth:      HMAC-SHA256, headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-PASSPHRASE, ACCESS-TIMESTAMP
 * Signature: Base64(HMAC-SHA256(timestamp + METHOD + requestPath + queryString + body))
 */
class WeexFuturesClient {
    /**
     * @param {Object} opts
     * @param {string} opts.apiKey
     * @param {string} opts.secretKey
     * @param {string} opts.passphrase
     * @param {string} [opts.baseUrl]
     * @param {number} [opts.timeoutMs]
     * @param {Function} [opts.onEvent] — Callback for client events (circuit-open, etc.)
     */
    constructor({ apiKey, secretKey, passphrase, baseUrl = BASE_URL_REST, timeoutMs = 15000, onEvent }) {
        this._apiKey = apiKey;
        this._secretKey = secretKey;
        this._passphrase = passphrase;
        this._baseUrl = baseUrl;
        this._signer = secretKey ? new WeexSignature(secretKey) : null;
        this._onEvent = onEvent || null;

        const JSONbig = require('json-bigint')({ storeAsString: true });
        this._http = axios.create({
            baseURL: baseUrl,
            timeout: timeoutMs,
            httpsAgent: new https.Agent({ rejectUnauthorized: true, minVersion: 'TLSv1.2' }),
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AlgoTradePro/2.0',
                'Accept': 'application/json'
            },
            transformResponse: [data => {
                if (!data) return data;
                try {
                    return JSONbig.parse(data);
                } catch (e) {
                    return data;
                }
            }]
        });

        this._breaker = createBreaker(
            (method, path, params, data) => this._execute(method, path, params, data),
            { name: 'weex-rest', timeout: timeoutMs + 2000 }
        );

        if (this._onEvent) {
            this._breaker.on('open', () => this._onEvent('circuitOpen', { name: 'weex-rest' }));
            this._breaker.on('close', () => this._onEvent('circuitClosed', { name: 'weex-rest' }));
        }
    }

    get isConfigured() {
        return Boolean(this._apiKey && this._secretKey && this._passphrase);
    }

    // -------------------------------------------------------------------------
    // Core transport
    // -------------------------------------------------------------------------

    async _execute(method, path, params, data) {
        const queryString = params && Object.keys(params).length
            ? new URLSearchParams(params).toString()
            : '';
        const fullPath = queryString ? `${path}?${queryString}` : path;
        const body = data ? JSON.stringify(data) : '';

        const headers = this._signer
            ? this._signer.buildHeaders({
                apiKey: this._apiKey,
                passphrase: this._passphrase,
                method: method.toUpperCase(),
                requestPath: path,
                queryString,
                body
            })
            : {};

        try {
            const response = await this._http.request({
                method,
                url: fullPath,
                data: data || undefined,
                headers
            });
            // WEEX wraps responses: { code: '0', data: {...}, msg: '' }
            const resData = response.data;
            if (resData?.code !== undefined && String(resData.code) !== '0') {
                throw new WeexApiError(resData.msg || 'API error', {
                    code: resData.code,
                    status: response.status,
                    path,
                    payload: resData
                });
            }
            return resData;
        } catch (err) {
            if (err instanceof WeexApiError) {
                // Business-level errors from WEEX (non-zero code with 2xx HTTP): don't retry.
                err.noRetry = true;
                throw err;
            }
            const status = err.response?.status;
            const payload = err.response?.data;
            const code = payload?.code || status || 'UNKNOWN';
            const message = payload?.msg || err.message;
            logger.error(`[WeexFutures] ${method} ${path} failed`, { status, code, message });
            const wrapped = new WeexApiError(message, { code, status, path, payload });
            // Retryable: timeout (408), rate limit (429), 5xx, and pure network errors (no status).
            // Non-retryable: 4xx (bad request, auth, not found) — fail fast.
            if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
                wrapped.noRetry = true;
            }
            throw wrapped;
        }
    }

    async _request(method, path, { params, data, authenticated = true, retries = 3 } = {}) {
        if (authenticated && !this.isConfigured) {
            throw new WeexApiError('WEEX credentials not configured', { code: 'NOT_CONFIGURED', path });
        }
        return withRetry(() => this._breaker.fire(method, path, params, data), {
            name: `weex:${path}`,
            retries
        });
    }

    // -------------------------------------------------------------------------
    // Account
    // -------------------------------------------------------------------------

    /** Get futures USDT balance */
    async getBalance(marginCoin = 'USDT') {
        const res = await this._request('GET', ENDPOINTS.account.balance, { params: { marginCoin } });
        return res?.data || res;
    }

    /**
     * Set leverage for a symbol.
     * @param {string} symbol — e.g. 'BTCUSDT'
     * @param {number} leverage — e.g. 5
     * @param {string} [positionSide] — 'LONG' | 'SHORT' | 'BOTH' (default 'BOTH')
     */
    async setLeverage({ symbol, leverage, marginCoin = 'USDT' }) {
        const res = await this._request('POST', ENDPOINTS.account.setLeverage, {
            data: { 
                symbol, 
                marginCoin,
                isolatedLongLeverage: String(leverage),
                isolatedShortLeverage: String(leverage)
            }
        });
        return res?.data;
    }

    /** Get all open positions */
    async getPositions() {
        const res = await this._request('GET', ENDPOINTS.account.positions);
        return res?.data || res || [];
    }

    /**
     * Historical fills with realizedPnl per execution.
     * GET /capi/v3/userTrades — WEEX USDT-M Futures.
     *
     * @param {Object} [opts]
     * @param {string} [opts.symbol]    — e.g. 'BTCUSDT'; omit to query all symbols
     * @param {string|number} [opts.orderId] — only fills of this order
     * @param {number} [opts.startTime] — ms epoch
     * @param {number} [opts.endTime]   — ms epoch (must be ≥ startTime)
     * @param {number} [opts.limit=100] — 1..100
     * @returns {Promise<Array<{
     *   id:number, orderId:number, symbol:string, buyer:boolean, maker:boolean,
     *   commission:string, commissionAsset:string, price:string, qty:string,
     *   quoteQty:string, realizedPnl:string, side:'BUY'|'SELL',
     *   positionSide:'LONG'|'SHORT', time:number
     * }>>}
     */
    async getUserTrades({ symbol, orderId, startTime, endTime, limit = 100 } = {}) {
        const params = { limit };
        if (symbol)    params.symbol    = symbol;
        if (orderId)   params.orderId   = orderId;
        if (startTime) params.startTime = startTime;
        if (endTime)   params.endTime   = endTime;

        const res = await this._request('GET', ENDPOINTS.order.userTrades, { params });
        return res?.data || res || [];
    }

    // -------------------------------------------------------------------------
    // Market (public — no auth required)
    // -------------------------------------------------------------------------

    /** Public health check / server time */
    async ping() {
        const res = await this._request('GET', ENDPOINTS.market.time, {
            authenticated: false
        });
        return res?.data || res;
    }

    /**
     * Get historical klines (OHLCV).
     * @param {string} symbol — e.g. 'BTCUSDT'
     * @param {string} tf     — internal TF string: '1m', '1h', '1D'
     * @param {number} [limit] — max 1000, default 200
     */
    async getCandles({ symbol, tf, limit = 200, startTime, endTime }) {
        const params = {
            symbol,
            interval: toInterval(tf),
            limit: String(limit)
        };
        if (startTime) params.startTime = String(startTime);
        if (endTime)   params.endTime   = String(endTime);

        const res = await this._request('GET', ENDPOINTS.market.klines, {
            params,
            authenticated: false
        });

        // WEEX kline response: array of [timestamp, open, high, low, close, volume, ...]
        const rows = res?.data || res || [];
        return rows.map((row) => ({
            timestamp: Number(row[0]),
            open:      Number(row[1]),
            high:      Number(row[2]),
            low:       Number(row[3]),
            close:     Number(row[4]),
            volume:    Number(row[5])
        }));
    }

    /** Get 24h ticker for a symbol */
    async getTicker(symbol) {
        const res = await this._request('GET', ENDPOINTS.market.ticker, {
            params: { symbol },
            authenticated: false
        });
        const list = Array.isArray(res) ? res : (res?.data || []);
        const d = list.find(x => x.symbol === symbol) || list[0] || {};
        
        return {
            symbol,
            lastPrice:  Number(d.lastPrice),
            bidPrice:   Number(d.bidPrice   ?? d.bestBid ?? d.lastPrice),
            askPrice:   Number(d.askPrice   ?? d.bestAsk ?? d.lastPrice),
            high24h:    Number(d.highPrice),
            low24h:     Number(d.lowPrice),
            volume24h:  Number(d.volume     ?? 0),
            markPrice:  Number(d.markPrice  ?? d.lastPrice ?? 0),
            fundingRate: Number(d.lastFundingRate ?? d.fundingRate ?? 0),
            timestamp:  Date.now()
        };
    }

    // -------------------------------------------------------------------------
    // Orders
    // -------------------------------------------------------------------------

    /**
     * C8 Phase 2: Place a conditional (Stop Loss / Take Profit) "Plan Order".
     * These orders are shown in the "Plan Order" or "TP/SL" tabs on the exchange.
     * Uses official V3 algoOrder endpoint.
     */
    async placePlanOrder(params) {
        logger.info('[WeexFutures] placePlanOrder', params);
        const res = await this._request('POST', ENDPOINTS.order.algoOrder, { data: params });
        return res?.data || res;
    }

    /**
     * C8 Phase 2: Specialized TP/SL order placement for positions.
     * Uses official V3 placeTpSlOrder endpoint.
     */
    async placeTpSlOrder(params) {
        const { symbol, triggerPrice, executePrice, quantity } = params;
        const precision = getAssetPrecision(symbol);
        
        const formatted = {
            ...params,
            triggerPrice: triggerPrice ? Number(triggerPrice).toFixed(precision.price) : undefined,
            executePrice: (executePrice && executePrice !== '0') ? Number(executePrice).toFixed(precision.price) : '0',
            quantity: quantity ? Number(quantity).toFixed(precision.qty) : undefined
        };

        logger.info('[WeexFutures] placeTpSlOrder', formatted);
        const res = await this._request('POST', ENDPOINTS.order.tpSlOrder, { data: formatted });
        return res?.data || res;
    }

    /**
     * C8 Phase 2: Modify an existing TP/SL conditional order in place.
     * POST /capi/v3/modifyTpSlOrder
     * Required: { orderId, triggerPrice } ; optional: { executePrice, triggerPriceType }
     * Response: { success: boolean }
     */
    async modifyTpSlOrder(params) {
        const { symbol, triggerPrice, executePrice } = params;
        const precision = getAssetPrecision(symbol);
        
        const formatted = {
            ...params,
            triggerPrice: triggerPrice ? Number(triggerPrice).toFixed(precision.price) : undefined,
            executePrice: (executePrice && executePrice !== '0') ? Number(executePrice).toFixed(precision.price) : undefined
        };

        logger.info('[WeexFutures] modifyTpSlOrder', formatted);
        const res = await this._request('POST', ENDPOINTS.order.modifyTpSl, { data: formatted });
        return res?.data || res;
    }

    /**
     * Place a futures order.
     *
     * WEEX place-order params (POST /capi/v3/order):
     *   symbol         — e.g. 'BTCUSDT'
     *   side           — 'BUY' | 'SELL'
     *   positionSide   — 'LONG' | 'SHORT'  (hedge mode)
     *   type           — 'MARKET' | 'LIMIT'
     *   quantity       — contract quantity (string)
     *   price          — required for LIMIT orders (string)
     *   newClientOrderId — optional client id (string)
     *   tpTriggerPrice — optional take-profit trigger price
     *   slTriggerPrice — optional stop-loss trigger price
     *
     * @returns {Promise<{orderId:string, clientOrderId:string}>}
     */
    async placeOrder({
        symbol,
        side,
        positionSide,
        orderType = ORDER_TYPE.MARKET,
        quantity,
        price,
        clientOrderId,
        tpTriggerPrice,
        slTriggerPrice,
        reduceOnly,
        timeInForce
    }) {
        if (!SIDE[side]) throw new WeexApiError(`Invalid side: ${side}`, { code: 'INVALID_SIDE' });
        if (!POSITION_SIDE[positionSide]) throw new WeexApiError(`Invalid positionSide: ${positionSide}`, { code: 'INVALID_POSITION_SIDE' });

        const precision = getAssetPrecision(symbol);
        const data = {
            symbol,
            side,
            positionSide,
            type: orderType,
            quantity: Number(quantity).toFixed(precision.qty)
        };
        if (orderType === ORDER_TYPE.LIMIT && price !== undefined) {
            data.price = Number(price).toFixed(precision.price);
        }
        data.newClientOrderId = clientOrderId || `at_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        if (tpTriggerPrice)       data.tpTriggerPrice = Number(tpTriggerPrice).toFixed(precision.price);
        if (slTriggerPrice)       data.slTriggerPrice = Number(slTriggerPrice).toFixed(precision.price);
        if (reduceOnly !== undefined) data.reduceOnly  = Boolean(reduceOnly);
        if (timeInForce)          data.timeInForce    = timeInForce;

        logger.info('[WeexFutures] placeOrder', { symbol, side, positionSide, orderType, quantity, reduceOnly });
        // Non-idempotent: retries=0 to avoid submitting duplicate orders when response is lost.
        const res = await this._request('POST', ENDPOINTS.order.place, { data, retries: 0 });
        // V3 might return {orderId: "..."} directly or wrapped in data
        return res?.data || res;
    }

    /**
     * C8 Phase 2: Place a TP ladder — up to 3 reduce-only LIMIT GTC orders.
     *
     * @param {Object} opts
     * @param {string} opts.symbol
     * @param {'long'|'short'} opts.side       — internal side of the position
     * @param {number} opts.totalQty           — total remaining quantity to split
     * @param {number|null} opts.tp1Price
     * @param {number|null} opts.tp2Price
     * @param {number|null} opts.tp3Price
     * @param {number} opts.tp1Pct             — fraction of totalQty for TP1 (e.g. 0.5)
     * @param {number} opts.tp2Pct             — fraction of totalQty for TP2 (e.g. 0.3)
     * @param {number} opts.tp3Pct             — fraction of totalQty for TP3 (e.g. 0.2)
     * @returns {Promise<{tp1OrderId:string|null, tp2OrderId:string|null, tp3OrderId:string|null}>}
     */
    async placeTpLadder({ symbol, side, totalQty, tp1Price, tp2Price, tp3Price, tp1Qty, tp2Qty, tp3Qty, tp1Pct, tp2Pct, tp3Pct }) {
        const precision = getAssetPrecision(symbol);
        // For LONG: close via SELL, positionSide=LONG
        // For SHORT: close via BUY, positionSide=SHORT
        const weexPositionSide = side === 'long' ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;

        // Accept either absolute qty (preferred — caller guarantees sum ≤ totalQty)
        // or legacy percent-based args. Percent path recomputes absolute qty with
        // the LAST present level receiving the remainder so rounding drift can
        // never overclose the position.
        let levels = [
            { key: 'tp1', price: tp1Price, qty: tp1Qty },
            { key: 'tp2', price: tp2Price, qty: tp2Qty },
            { key: 'tp3', price: tp3Price, qty: tp3Qty }
        ];
        const hasAbsoluteQty = levels.some((l) => Number.isFinite(l.qty) && l.qty > 0);
        if (!hasAbsoluteQty) {
            const roundQty = (q) => Number(Number(q).toFixed(precision.qty));
            const pcts = { tp1: tp1Pct, tp2: tp2Pct, tp3: tp3Pct };
            // Find the LAST level with a valid price — it gets the remainder.
            const presentKeys = levels
                .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(pcts[l.key]) && pcts[l.key] > 0)
                .map((l) => l.key);
            const lastKey = presentKeys[presentKeys.length - 1] || null;

            let allocated = 0;
            levels = levels.map((l) => {
                if (!Number.isFinite(l.price) || l.price <= 0) return l;
                if (!Number.isFinite(pcts[l.key]) || pcts[l.key] <= 0) return l;
                let qty;
                if (l.key === lastKey) {
                    qty = roundQty(totalQty - allocated);
                } else {
                    qty = roundQty(totalQty * pcts[l.key]);
                    allocated += qty;
                }
                return { ...l, qty };
            });
        }

        const result = { tp1OrderId: null, tp2OrderId: null, tp3OrderId: null };

        // Hard guard: sum of absolute qty must not exceed totalQty. Excess can only
        // happen with buggy callers; clamp the last level rather than overclosing.
        const qtySum = levels.reduce((s, l) => s + (Number.isFinite(l.qty) ? l.qty : 0), 0);
        if (qtySum > totalQty + 1e-9) {
            const overflow = qtySum - totalQty;
            for (let i = levels.length - 1; i >= 0; i--) {
                if (Number.isFinite(levels[i].qty) && levels[i].qty > 0) {
                    const clamped = Math.max(0, levels[i].qty - overflow);
                    logger.warn('[WeexFutures] placeTpLadder qty sum exceeds totalQty — clamping last level', {
                        symbol, totalQty, qtySum, level: levels[i].key, was: levels[i].qty, now: clamped
                    });
                    levels[i] = { ...levels[i], qty: clamped };
                    break;
                }
            }
        }

        for (const { key, price, qty } of levels) {
            if (!price || !Number.isFinite(price)) continue;
            if (!Number.isFinite(qty) || qty <= 0) continue;

            const qtyStr = qty.toFixed(precision.qty);

            try {
                const clientAlgoId = `tp_${key}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
                const res = await this.placeTpSlOrder({
                    symbol,
                    planType: 'TAKE_PROFIT',
                    triggerPrice: Number(price).toFixed(precision.price),
                    executePrice: '0', // Market TP for guaranteed execution and UI visibility
                    quantity: qtyStr,
                    positionSide: weexPositionSide,
                    triggerPriceType: 'MARK_PRICE',
                    clientAlgoId
                });
                result[`${key}OrderId`] = res?.orderId || res?.data?.orderId || clientAlgoId;
                logger.info(`[WeexFutures] TP ladder ${key} placed as Plan Order`, { symbol, side, price, qty: qtyStr, orderId: result[`${key}OrderId`] });
            } catch (err) {
                // Log but don't fail the whole ladder — remaining levels may still succeed.
                logger.warn(`[WeexFutures] placeTpLadder ${key} failed`, { symbol, price, qty: qtyStr, message: err.message });
            }
        }

        return result;
    }

    /**
     * C8 Phase 2: Cancel bot-placed open orders for a symbol (both standard and algo).
     * Filters by clientOrderId prefix.
     *
     * @param {string} symbol
     * @param {Object} [opts]
     * @param {string[]} [opts.prefixes] — allowlist of clientOrderId prefixes. Default: all bot prefixes.
     * @returns {Promise<{cancelled:string[], skipped:string[]}>}
     */
    async cancelAllForSymbol(symbol, opts = {}) {
        const prefixes = Array.isArray(opts.prefixes) && opts.prefixes.length > 0
            ? opts.prefixes
            : ['at_', 'tp_', 'sl_'];

        let basicOrders = [];
        let algoOrders = [];

        try {
            // Fetch both standard limit orders and conditional/plan orders
            const [basicRes, algoRes] = await Promise.all([
                this.getOpenOrders(symbol),
                this.getAlgoOpenOrders(symbol)
            ]);
            basicOrders = Array.isArray(basicRes) ? basicRes : (basicRes?.data || []);
            algoOrders = Array.isArray(algoRes) ? algoRes : (algoRes?.data || []);
        } catch (err) {
            logger.warn('[WeexFutures] cancelAllForSymbol: fetch failed', { symbol, message: err.message });
            return { cancelled: [], skipped: [] };
        }

        // Combine and filter by our prefixes
        const allOrders = [...basicOrders, ...algoOrders];
        const botOrders = allOrders.filter((o) => {
            const cid = String(o.clientOrderId || o.origClientOrderId || o.newClientOrderId || o.clientAlgoId || '');
            return prefixes.some((p) => cid.startsWith(p));
        });

        if (botOrders.length === 0) return { cancelled: [], skipped: [] };

        logger.info('[WeexFutures] cancelAllForSymbol', { symbol, count: botOrders.length, prefixes });

        const cancelled = [];
        const skipped = [];
        for (const o of botOrders) {
            try {
                // Determine which endpoint to use based on order type
                // Algo orders in WEEX usually have 'clientAlgoId' or 'planType'
                const isAlgo = Boolean(o.clientAlgoId || o.planType || o.algoId);
                
                if (isAlgo) {
                    await this.cancelAlgoOrder({ symbol, orderId: o.orderId || o.algoId });
                } else {
                    await this.cancelOrder({ symbol, orderId: o.orderId });
                }
                cancelled.push(o.orderId || o.algoId);
            } catch (err) {
                logger.debug('[WeexFutures] cancel order skipped', { orderId: o.orderId || o.algoId, message: err.message });
                skipped.push(o.orderId || o.algoId);
            }
        }
        return { cancelled, skipped };
    }

    /**
     * C8 Phase 2: Modify TP/SL of an existing conditional order (breakeven move).
     * Uses WEEX "Modify TP/SL Conditional Order" endpoint POST /capi/v3/order/tpSl.
     *
     * @param {Object} opts
     * @param {string} opts.symbol
     * @param {string} [opts.orderId]          — WEEX order id of the SL order to modify
     * @param {number} [opts.slTriggerPrice]   — new SL trigger price
     * @param {number} [opts.tpTriggerPrice]   — new TP trigger price
     */
    async modifySlTp({ symbol, orderId, slTriggerPrice, tpTriggerPrice }) {
        const data = { symbol };
        if (orderId)        data.orderId        = orderId;
        if (slTriggerPrice) data.slTriggerPrice = String(slTriggerPrice);
        if (tpTriggerPrice) data.tpTriggerPrice = String(tpTriggerPrice);

        logger.info('[WeexFutures] modifySlTp', { symbol, orderId, slTriggerPrice, tpTriggerPrice });
        const res = await this._request('POST', ENDPOINTS.order.modifySlTp, { data, retries: 1 });
        return res?.data || res;
    }

    /**
     * Cancel an open order.
     * DELETE /capi/v3/order
     */
    async cancelOrder({ symbol, orderId, clientOrderId }) {
        const params = { symbol };
        if (orderId)       params.orderId       = String(orderId);
        if (clientOrderId) params.origClientOrderId = clientOrderId;
        // DELETE is idempotent by HTTP spec but WEEX may return OK-after-already-cancelled on retry; 1 retry max.
        // Using 'params' for DELETE as many V3 APIs require query parameters for cancellation.
        const res = await this._request('DELETE', ENDPOINTS.order.cancel, { params, retries: 1 });
        return res?.data;
    }

    /** Get open orders for a symbol */
    async getOpenOrders(symbol) {
        const res = await this._request('GET', ENDPOINTS.order.openOrders, {
            params: symbol ? { symbol } : {}
        });
        return res?.data || res || [];
    }

    /**
     * C8 Phase 2: Get current conditional (algo/plan) orders for a symbol.
     * GET /capi/v3/openAlgoOrders
     */
    async getAlgoOpenOrders(symbol) {
        const res = await this._request('GET', ENDPOINTS.order.openAlgoOrders, {
            params: symbol ? { symbol } : {}
        });
        return res?.data || res || [];
    }

    /**
     * C8 Phase 2: Cancel a specific conditional (algo/plan) order.
     * DELETE /capi/v3/algoOrder
     */
    async cancelAlgoOrder({ symbol, orderId }) {
        const params = { symbol, orderId: String(orderId) };
        const res = await this._request('DELETE', ENDPOINTS.order.algoOrder, { params, retries: 1 });
        return res?.data || res;
    }

    /** Query a specific order */
    async getOrder({ symbol, orderId, clientOrderId }) {
        const params = { symbol };
        
        // If orderId is a string starting with bot prefixes, treat it as clientOrderId
        const idStr = String(orderId || '');
        const isBotId = idStr.startsWith('at_') || idStr.startsWith('tp_') || idStr.startsWith('sl_');

        if (orderId && !isBotId) {
            params.orderId = String(orderId);
        } else if (orderId && isBotId) {
            // C8 Phase 2 fix: WEEX V3 GET /capi/v3/order requires 'orderId' NOT to be empty
            // even if origClientOrderId is provided. If we only have a bot-id, 
            // we should technically query via openAlgoOrders or handle as a no-op here
            // to prevent 400 error and circuit breaker opening.
            params.origClientOrderId = idStr;
        }

        if (clientOrderId) {
            params.origClientOrderId = clientOrderId;
        }

        // C8 Phase 2 fix: WEEX V3 requires orderId. If we only have clientOrderId, 
        // this endpoint (/capi/v3/order) will fail with 400.
        if (!params.orderId && !params.origClientOrderId) {
            logger.warn('[WeexFutures] getOrder skipped: no orderId or clientOrderId provided');
            return null;
        }

        const res = await this._request('GET', ENDPOINTS.order.query, { params });
        return res?.data || res;
    }
}

module.exports = { WeexFuturesClient, WeexApiError, SIDE, POSITION_SIDE, ORDER_TYPE };
