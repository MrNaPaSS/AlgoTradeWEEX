const logger = require('../utils/logger');
const { SIDE, POSITION_SIDE, ORDER_TYPE } = require('../api/weex/endpoints');

// Prometheus metrics (lazy — avoid circular require during initial module loading).
let _metricsRef = null;
try { _metricsRef = require('../routes/metrics').metrics; } catch (_) { /* optional */ }

/**
 * LiveBroker — adapter around WeexFuturesClient exposing the same
 * surface as PaperBroker so TradingOrchestrator is mode-agnostic.
 */
class LiveBroker {
    /**
     * @param {Object} opts
     * @param {import('../api/weex/WeexFuturesClient').WeexFuturesClient} opts.client
     */
    constructor({ client, takerFeeRate = 0.0004, balanceStaleThreshold = 3, userId = null } = {}) {
        this._client = client;
        this._takerFeeRate = takerFeeRate;
        this._userId = userId;
        // Balance cache: return last-known on transient failure, only return 0 after N consecutive fails.
        this._lastBalance = null;
        this._balanceFailStreak = 0;
        this._balanceStaleThreshold = balanceStaleThreshold;
    }

    get mode() {
        return 'live';
    }

    /**
     * Retrieve available USDT balance from the exchange.
     */
    async getAvailableBalanceUsd() {
        try {
            const res = await this._client.getBalance();
            const data = Array.isArray(res) ? res : (res?.data || res || []);

            // WEEX V3 returns array of balances. Find USDT or default margin coin
            const usdt = data.find(b =>
                String(b.asset).toUpperCase() === 'USDT' ||
                String(b.marginCoin).toUpperCase() === 'USDT' ||
                String(b.coin).toUpperCase() === 'USDT'
            );

            if (!usdt) {
                logger.warn('[LiveBroker] USDT asset not found in balance response', { availableAssets: data.map(b => b.asset || b.marginCoin) });
                this._balanceFailStreak++;
                return this._fallbackBalance();
            }

            const available = parseFloat(usdt.availableBalance || usdt.available || usdt.availableMargin || usdt.maxWithdrawAmount || '0');
            if (!Number.isFinite(available) || available < 0) {
                this._balanceFailStreak++;
                return this._fallbackBalance();
            }
            this._lastBalance = available;
            this._balanceFailStreak = 0;
            logger.debug('[LiveBroker] balance detected', { available });
            return available;
        } catch (err) {
            this._balanceFailStreak++;
            logger.error('[LiveBroker] getAvailableBalanceUsd failed', {
                message: err.message, streak: this._balanceFailStreak
            });
            return this._fallbackBalance();
        }
    }

    _fallbackBalance() {
        // Within tolerance — return last known balance (stale but safer than zero).
        if (this._balanceFailStreak < this._balanceStaleThreshold && Number.isFinite(this._lastBalance)) {
            logger.warn('[LiveBroker] returning cached last-known balance', {
                lastBalance: this._lastBalance, streak: this._balanceFailStreak
            });
            return this._lastBalance;
        }
        // Exceeded tolerance — return 0 to block trading.
        logger.error('[LiveBroker] balance fetch failed beyond tolerance, returning 0', {
            streak: this._balanceFailStreak, threshold: this._balanceStaleThreshold
        });
        return 0;
    }

    /**
     * @param {Object} opts
     * @param {string} opts.symbol - 'BTCUSDT'
     * @param {string} opts.side - 'long' | 'short' (internal direction)
     * @param {number} opts.quantity
     * @param {number} opts.leverage
     * @param {number} opts.price
     * @param {number} opts.stopLoss
     * @param {number} opts.tpPrice
     */
    async placeMarketOrder({ symbol, side, quantity, leverage, stopLoss, tpPrice }) {
        // Set leverage first
        try {
            await this._client.setLeverage({ symbol, leverage, marginCoin: 'USDT' });
        } catch (err) {
            // WEEX fails leverage update if there are open orders. 
            // In this case, we proceed assuming current leverage is acceptable.
            if (String(err.message).includes('open orders') || String(err.code) === '-1054') {
                logger.warn('[LiveBroker] leverage update skipped (open orders exist)', { symbol });
            } else {
                throw err;
            }
        }

        // Map internal side to WEEX params
        // To OPEN a LONG -> SIDE: BUY, positionSide: LONG
        // To OPEN a SHORT -> SIDE: SELL, positionSide: SHORT
        const weexSide = side === 'long' ? SIDE.BUY : SIDE.SELL;
        const weexPositionSide = side === 'long' ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;

        const res = await this._client.placeOrder({
            symbol,
            side: weexSide,
            positionSide: weexPositionSide,
            orderType: ORDER_TYPE.MARKET,
            quantity,
            slTriggerPrice: stopLoss ? stopLoss : undefined,
            tpTriggerPrice: tpPrice ? tpPrice : undefined
        });

        // C8 Phase 2 fix (Bug 1): WEEX V3 ignores slTriggerPrice in main order endpoint.
        // We MUST place SL/TP separately via placeTpSlOrder to ensure protection.
        let slOrderId = null;
        let tpOrderId = null;

        if (stopLoss) {
            logger.info('[LiveBroker] Attaching SL via V3 placeTpSlOrder...', { symbol, stopLoss });
            slOrderId = await this._attachSlWithRetry({
                symbol, quantity, stopLoss, weexPositionSide
            });

            if (!slOrderId) {
                // FAIL-CLOSED: naked entry is the single worst failure mode in
                // leveraged futures — one adverse candle can liquidate. If all
                // SL attach retries failed, close the entry at market immediately
                // and throw so the caller treats this as a failed open, not a
                // successful one with silent degradation.
                logger.error('[LiveBroker] CRITICAL: SL attach failed after retries — closing naked entry (fail-closed)', {
                    symbol, side, quantity, stopLoss
                });
                try {
                    await this._client.placeOrder({
                        symbol,
                        side: side === 'long' ? SIDE.SELL : SIDE.BUY,
                        positionSide: weexPositionSide,
                        orderType: ORDER_TYPE.MARKET,
                        quantity
                    });
                    logger.warn('[LiveBroker] fail-closed market close succeeded — entry reversed', { symbol });
                } catch (closeErr) {
                    logger.error('[LiveBroker] CRITICAL: fail-closed market close ALSO failed — MANUAL INTERVENTION REQUIRED', {
                        symbol, message: closeErr.message
                    });
                }
                try {
                    _metricsRef?.slAttachOutcomesTotal?.labels(
                        String(this._userId || 'master'), symbol, 'fail_closed'
                    ).inc();
                } catch (_) { /* noop */ }
                const e = new Error(`SL attach failed for ${symbol} — entry fail-closed`);
                e.code = 'SL_ATTACH_FAILED';
                throw e;
            }
        }

        if (tpPrice) {
            try {
                const tpRes = await this._client.placeTpSlOrder({
                    symbol,
                    planType: 'TAKE_PROFIT',
                    triggerPrice: String(tpPrice),
                    executePrice: '0', // Market
                    quantity: String(quantity),
                    positionSide: weexPositionSide,
                    triggerPriceType: 'MARK_PRICE',
                    clientAlgoId: 'tp_' + Date.now()
                });
                tpOrderId = this._parseTpSlOrderId(tpRes);
                logger.debug('[LiveBroker] TP attach response', { tpRes, parsed: tpOrderId });
            } catch (err) {
                // TP attach is non-critical (SL protects from loss; ladder handles TPs).
                logger.warn('[LiveBroker] single TP attach failed (non-critical)', { symbol, message: err.message });
            }
        }

        if (slOrderId || tpOrderId) {
            logger.info('[LiveBroker] SL/TP protection active', { slOrderId, tpOrderId });
        }

        logger.info('[LiveBroker] market open', {
            symbol, side, quantity,
            orderId: res.orderId,
            slAttached: Boolean(stopLoss),
            tpAttached: Boolean(tpPrice),
            slOrderId,
            tpOrderId
        });

        return {
            orderId: res.orderId || res.data?.orderId,
            slOrderId,
            tpOrderId,
            symbol,
            side,
            action: 'open',
            quantity,
            price: res.price || null,
            filledAt: Date.now()
        };
    }

    /**
     * @param {Object} opts
     * @param {string} opts.symbol
     * @param {string} opts.side - 'long' | 'short'
     * @param {number} opts.quantity
     */
    async closeMarket({ symbol, side, quantity, entryPrice, markPrice }) {
        // Map internal side to WEEX params for CLOSING
        // To CLOSE a LONG -> SIDE: SELL, positionSide: LONG
        // To CLOSE a SHORT -> SIDE: BUY, positionSide: SHORT
        const weexSide = side === 'long' ? SIDE.SELL : SIDE.BUY;
        const weexPositionSide = side === 'long' ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;

        const res = await this._client.placeOrder({
            symbol,
            side: weexSide,
            positionSide: weexPositionSide,
            orderType: ORDER_TYPE.MARKET,
            quantity
        });

        const orderId = res.orderId || res.data?.orderId;

        // Authoritative PnL straight from the exchange. WEEX `userTrades`
        // returns one row per fill with the canonical `realizedPnl` and
        // `commission` — this is the truth (already in WEEX's books). We used
        // to recompute pnl locally as (fill-entry)*qty - fee, but that is
        // brittle: market `placeOrder` doesn't echo fillPrice and the
        // caller-supplied markPrice fallback was sometimes just entryPrice
        // (resulting in pnl ≈ −fees regardless of actual market move).
        let pnl = null;
        let fillPrice = null;
        let fills = [];
        if (orderId) {
            // Market fills are <100ms but userTrades needs a moment to index.
            // Probe up to 3 times: immediate, +250ms, +600ms. Stops early once
            // we see fills covering the requested quantity.
            const targetQty = Number(quantity);
            const delays = [0, 250, 600];
            for (const ms of delays) {
                if (ms) await new Promise((r) => setTimeout(r, ms));
                try {
                    const got = await this._client.getUserTrades({ symbol, orderId, limit: 50 });
                    if (Array.isArray(got) && got.length > 0) {
                        fills = got;
                        const qtySum = fills.reduce((s, f) => s + Number(f.qty || 0), 0);
                        if (qtySum >= targetQty - 1e-6) break;
                    }
                } catch (err) {
                    logger.debug('[LiveBroker] closeMarket: getUserTrades probe failed', {
                        delay: ms, message: err.message
                    });
                }
            }
        }

        if (fills.length > 0) {
            // Sum across fills. realizedPnl is gross PnL, commission is the
            // closing fee (open fee was deducted at entry). Subtract commission
            // to get net realized.
            let pnlSum = 0;
            let qtySum = 0;
            let quoteSum = 0;
            for (const f of fills) {
                pnlSum   += Number(f.realizedPnl || 0);
                pnlSum   -= Math.abs(Number(f.commission || 0));
                qtySum   += Number(f.qty || 0);
                quoteSum += Number(f.quoteQty || 0);
            }
            pnl = pnlSum;
            fillPrice = qtySum > 0 ? quoteSum / qtySum : null;
            logger.info('[LiveBroker] market close (authoritative pnl from userTrades)', {
                symbol, side, quantity, fillPrice, entryPrice, pnl, orderId,
                fillCount: fills.length, qtySum
            });
        } else {
            // Last-resort fallback: WEEX hasn't indexed the fill yet. Compute
            // approximation locally so we at least record SOMETHING and the
            // backfill_pnl.js script can correct it later from authoritative data.
            const approxFill = Number(res.price || res.data?.price) || Number(markPrice) || null;
            if (Number.isFinite(entryPrice) && Number.isFinite(approxFill) && Number.isFinite(quantity)) {
                const gross = side === 'long'
                    ? (approxFill - entryPrice) * quantity
                    : (entryPrice - approxFill) * quantity;
                const fee = Math.abs(approxFill * quantity) * this._takerFeeRate;
                pnl = gross - fee;
                fillPrice = approxFill;
            } else {
                pnl = 0;
            }
            logger.warn('[LiveBroker] market close: userTrades empty, using approximation', {
                symbol, side, quantity, fillPrice, entryPrice, pnl, orderId
            });
        }

        return {
            orderId: res.orderId || res.data?.orderId,
            symbol,
            side,
            action: 'close',
            quantity,
            price: fillPrice,
            pnl,
            filledAt: Date.now()
        };
    }
    async getOpenPositions() {
        const raw = await this._client.getPositions();
        logger.debug('[LiveBroker] raw positions response', { raw: JSON.stringify(raw).substring(0, 2000) });
        // WEEX returns array of positions. We need to map to our internal format.
        // Usually raw.data is the array.
        const list = Array.isArray(raw) ? raw : (raw?.data || []);
        
        return list
            .filter(p => Number(p.size || p.total) > 0)
            .map(p => {
                const size = Number(p.size || p.total);
                // WEEX does not return entryPrice directly — derive from openValue / size.
                // Fall back to explicit fields if a future API version provides them.
                let entryPrice = Number(p.entryPrice || p.avgPrice || p.openPrice);
                if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
                    const openValue = Number(p.openValue || p.cumOpenValue);
                    if (Number.isFinite(openValue) && size > 0) {
                        entryPrice = openValue / size;
                    }
                }
                const unrealizedPnl = Number(p.unrealizePnl ?? p.unrealizedPnl ?? p.unrealisedPnl);
                const liquidatePrice = Number(p.liquidatePrice);
                return {
                    symbol: p.symbol,
                    side: String(p.side || p.positionSide).toLowerCase(), // 'long' or 'short'
                    entryPrice,
                    totalQuantity: size,
                    remainingQuantity: size,
                    leverage: Number(p.leverage),
                    unrealizedPnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : null,
                    liquidatePrice: Number.isFinite(liquidatePrice) ? liquidatePrice : null,
                    marginSize: Number(p.isolatedMargin || p.marginSize) || null
                };
            });
    }

    /**
     * @param {Object} opts
     */
    async placeTpLadder(opts) {
        return this._client.placeTpLadder(opts);
    }

    /**
     * @param {string} symbol
     * @param {Object} [opts]
     * @param {string[]} [opts.prefixes] — clientOrderId prefix allowlist
     */
    async cancelAllForSymbol(symbol, opts) {
        return this._client.cancelAllForSymbol(symbol, opts);
    }

    /**
     * C8 Phase 2 fix (C1): public cancel-by-id so PositionManager does not reach
     * into `broker._client` directly.
     */
    async cancelOrderById({ symbol, orderId, clientOrderId }) {
        return this._client.cancelOrder({ symbol, orderId, clientOrderId });
    }

    /**
     * C8 Phase 2 fix (C1): public order-status query. Returns the raw WEEX
     * order object so the caller can read status/executedQty/avgPrice directly.
     */
    async getOrder({ symbol, orderId, clientOrderId }) {
        return this._client.getOrder({ symbol, orderId, clientOrderId });
    }

    /**
     * Parse the WEEX placeTpSlOrder response to extract the new plan orderId.
     * Docs shape: [{ success: true, orderId: 812345..., errorCode, errorMessage }]
     * But we also defensively handle envelope variants.
     */
    _parseTpSlOrderId(res) {
        if (res == null) return null;
        if (Array.isArray(res)) {
            const first = res[0];
            if (first && first.success === false) return null;
            return first?.orderId ? String(first.orderId) : null;
        }
        if (res.orderId) return String(res.orderId);
        if (Array.isArray(res.data)) return this._parseTpSlOrderId(res.data);
        return null;
    }

    /**
     * Place a STOP_LOSS plan order with bounded retries. Returns the orderId
     * on success, null if all attempts failed. Transient WEEX errors (rate
     * limit, network blip, 5xx) are expected and retried; permanent errors
     * (bad params, position already closed) short-circuit out after first try
     * via the error shape. Caller must treat null as fatal and fail-closed.
     */
    async _attachSlWithRetry({ symbol, quantity, stopLoss, weexPositionSide }) {
        const maxAttempts = 3;
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const slRes = await this._client.placeTpSlOrder({
                    symbol,
                    planType: 'STOP_LOSS',
                    triggerPrice: String(stopLoss),
                    executePrice: '0', // Market on trigger
                    quantity: String(quantity),
                    positionSide: weexPositionSide,
                    triggerPriceType: 'MARK_PRICE',
                    // Unique clientAlgoId per attempt so a silent success on attempt N
                    // doesn't collide with the retry's id.
                    clientAlgoId: `sl_${Date.now()}_${attempt}`
                });
                const id = this._parseTpSlOrderId(slRes);
                if (id) {
                    if (attempt > 1) {
                        logger.warn('[LiveBroker] SL attach succeeded after retry', { symbol, attempt, slOrderId: id });
                    }
                    try {
                        _metricsRef?.slAttachOutcomesTotal?.labels(
                            String(this._userId || 'master'), symbol, attempt > 1 ? 'retry' : 'success'
                        ).inc();
                    } catch (_) { /* noop */ }
                    return id;
                }
                logger.warn('[LiveBroker] SL attach returned no orderId', { symbol, attempt, slRes });
            } catch (err) {
                lastErr = err;
                logger.warn('[LiveBroker] SL attach attempt failed', {
                    symbol, attempt, message: err.message, code: err.code
                });
            }
            if (attempt < maxAttempts) {
                // Linear backoff 400 / 800ms — bounded total wait ~1.2s so the
                // entry isn't naked for long while transient errors clear.
                await new Promise((r) => setTimeout(r, 400 * attempt));
            }
        }
        if (lastErr) {
            logger.error('[LiveBroker] SL attach exhausted retries', {
                symbol, message: lastErr.message, code: lastErr.code
            });
        }
        return null;
    }

    /**
     * C8 Phase 2: modify an existing SL or TP conditional order.
     *
     * Strategy:
     *   1. If we have a tracked orderId → use POST /capi/v3/modifyTpSlOrder (in-place
     *      modify — one atomic call, no orphan risk). This is the happy path.
     *   2. If no tracked id → legacy fallback: cancel existing bot-prefixed plan
     *      orders, then re-create. Kept for safety during migration.
     *
     * Returns { success: boolean, mode: 'modify'|'replace', reason? } — never throws
     * on business-validation failures (e.g. trigger price too close to mark).
     */
    async modifySlTp({ symbol, orderId, slTriggerPrice, tpTriggerPrice }) {
        logger.info('[LiveBroker] modifySlTp', { symbol, orderId, slTriggerPrice, tpTriggerPrice });

        // Happy path: tracked orderId + single trigger → single atomic modify call.
        if (orderId && (slTriggerPrice || tpTriggerPrice) && !(slTriggerPrice && tpTriggerPrice)) {
            try {
                const trigger = slTriggerPrice || tpTriggerPrice;
                const modRes = await this._client.modifyTpSlOrder({
                    symbol,
                    orderId: String(orderId),
                    triggerPrice: String(trigger),
                    triggerPriceType: 'MARK_PRICE'
                });
                const success = modRes?.success !== false;
                logger.info('[LiveBroker] modifyTpSlOrder result', { orderId, success, modRes });
                if (success) return { success: true, mode: 'modify' };
                return { success: false, mode: 'modify', reason: 'exchange rejected modify' };
            } catch (err) {
                logger.warn('[LiveBroker] modifyTpSlOrder failed, falling back to cancel+replace', { message: err.message });
                // fall through to replace path
            }
        }

        // Fallback: cancel bot-prefixed plan orders then re-create.
        try {
            const prefixes = [];
            if (slTriggerPrice) prefixes.push('sl_');
            if (tpTriggerPrice) prefixes.push('tp_');

            if (prefixes.length > 0) {
                logger.info('[LiveBroker] modifySlTp fallback: clearing old plan orders', { prefixes });
                await this.cancelAllForSymbol(symbol, { prefixes });
            } else if (orderId) {
                await this.cancelOrderById({ symbol, orderId });
            }

            const positions = await this.getOpenPositions();
            const pos = positions.find(p => p.symbol === symbol);
            if (!pos) {
                logger.warn('[LiveBroker] modifySlTp skipped: no active position for', symbol);
                return { success: false, mode: 'replace', reason: 'no position' };
            }

            const { POSITION_SIDE } = require('../api/weex/endpoints');
            const weexPositionSide = pos.side === 'long' ? POSITION_SIDE.LONG : POSITION_SIDE.SHORT;

            let newSlOrderId = null;
            let newTpOrderId = null;

            if (slTriggerPrice) {
                const slRes = await this._client.placeTpSlOrder({
                    symbol,
                    planType: 'STOP_LOSS',
                    triggerPrice: String(slTriggerPrice),
                    executePrice: '0',
                    quantity: String(pos.remainingQuantity),
                    positionSide: weexPositionSide,
                    triggerPriceType: 'MARK_PRICE',
                    clientAlgoId: 'sl_' + Date.now()
                });
                newSlOrderId = this._parseTpSlOrderId(slRes);
            }

            if (tpTriggerPrice) {
                const tpRes = await this._client.placeTpSlOrder({
                    symbol,
                    planType: 'TAKE_PROFIT',
                    triggerPrice: String(tpTriggerPrice),
                    executePrice: '0',
                    quantity: String(pos.remainingQuantity),
                    positionSide: weexPositionSide,
                    triggerPriceType: 'MARK_PRICE',
                    clientAlgoId: 'tp_' + Date.now()
                });
                newTpOrderId = this._parseTpSlOrderId(tpRes);
            }

            logger.info('[LiveBroker] modifySlTp replace successful', { newSlOrderId, newTpOrderId });
            return { success: true, mode: 'replace', slOrderId: newSlOrderId, tpOrderId: newTpOrderId };
        } catch (err) {
            logger.error('[LiveBroker] modifySlTp replace FAILED', { message: err.message });
            // Business validation (INVALID_ARGUMENT / -1054) → surface as success:false, not throw
            if (/INVALID_ARGUMENT|-1054/.test(err.message || '')) {
                return { success: false, mode: 'replace', reason: err.message };
            }
            throw err;
        }
    }
}

module.exports = { LiveBroker };
