const { Mutex } = require('async-mutex');
const { createPosition, updatePosition, computeUnrealizedPnl } = require('../domain/Position');
const { getAssetPrecision } = require('../config/assets');
const logger = require('../utils/logger');

/**
 * C8 Phase 1: detect "position already closed" races. When exchange-side SL
 * fires, our next closeMarket attempt gets a position-not-found / zero-size
 * error from WEEX. Treat those as successful no-ops for the local state.
 * Matches WEEX error messages and common HTTP-level markers.
 */
function _isAlreadyClosedError(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    const code = String(err.code || err.retCode || '');
    return (
        msg.includes('position not found') ||
        msg.includes('position does not exist') ||
        msg.includes('no open position') ||
        msg.includes('insufficient position') ||
        msg.includes('position size is zero') ||
        msg.includes('already closed') ||
        // WEEX-known error codes for closed-position attempts (best-effort; extend as seen in prod):
        code === '-3003' || code === '40034'
    );
}

/**
 * Multi-symbol position manager. One Mutex per symbol eliminates race
 * conditions between concurrent webhooks / WS events on the same instrument.
 */
class PositionManager {
    /**
     * @param {Object} opts
     * @param {import('./database').Database} opts.database
     * @param {{placeMarketOrder:Function, closeMarket:Function, mode:string}} opts.broker
     * @param {(event:string, payload:Object)=>void} [opts.onEvent]
     * @param {import('./riskGuard').RiskGuard} [opts.riskGuard]
     */
    constructor({ database, broker, riskGuard, minNotionalUsd = 5, config = {}, userId = null, onEvent = () => {} }) {
        this._db = database;
        this._broker = broker;
        this._riskGuard = riskGuard;
        this._minNotionalUsd = minNotionalUsd;
        this._onEvent = onEvent;
        this._config = config;
        this._userId = userId;
        
        /** @type {Map<string, import('../domain/types').Position[]>} */
        this._positions = new Map();
        /** @type {Map<string, Mutex>} */
        this._locks = new Map();

        this._pollTimer = null;
        this._pollIntervalMs = config.risk?.tpPollIntervalMs || 15000;

        // Hydration is async — kicked off in background so the constructor
        // remains synchronous. Callers that need a guaranteed-populated state
        // should `await pm.hydrated` before reading.
        this.hydrated = this._hydrate().catch((err) => {
            logger.error('[PositionManager] hydrate failed', { message: err.message });
        });
        // C8 Phase 2: auto-start polling on live mode; no-op on paper.
        // Public `startTpPolling()` is idempotent and checks broker mode internally.
        this.startTpPolling();
    }

    async _hydrate() {
        this._positions.clear();
        const rows = await this._db.getOpenPositions(undefined, this._userId);
        for (const r of rows) {
            this._push(this._rowToPosition(r));
        }
        logger.info('[PositionManager] hydrated from DB', { count: rows.length, userId: this._userId });
    }

    /**
     * C8 Phase 2 fix (syncWithExchange SL restore):
     * When re-hydrating after a process kill, we need to check if the position
     * has active SL orders on the exchange. If so, restore slOrderId and exchangeSlActive.
     */
    async syncWithExchange() {
        try {
            await this.hydrated;
            const remotePositions = await this._broker.getOpenPositions();
            const currentPositions = this.getOpen();

            // 1. Sync positions from exchange to local state
            for (const p of remotePositions) {
                const existing = currentPositions.find(pos => pos.symbol === p.symbol && pos.side.toLowerCase() === p.side.toLowerCase());
                
                if (existing) {
                    // Update existing position with latest qty from exchange
                    if (existing.remainingQuantity !== p.remainingQuantity) {
                        logger.info('[PositionManager] Updating position qty from exchange sync', { 
                            symbol: p.symbol, old: existing.remainingQuantity, new: p.remainingQuantity 
                        });
                        const updated = updatePosition(existing, { remainingQuantity: p.remainingQuantity });
                        await this._db.updatePosition(updated);
                        this._replace(updated);
                    }

                    // C8 Phase 2 fix (syncWithExchange SL restore):
                    // If we don't have a tracked SL but one exists on exchange, restore it.
                    if (this._broker.mode === 'live' && !existing.slOrderId) {
                        try {
                            const openOrders = await this._broker._client.getOpenOrders(p.symbol);
                            const slOrder = openOrders.find(o => o.clientOrderId?.startsWith('sl_'));
                            if (slOrder) {
                                logger.info('[PositionManager] restored SL state on existing position during sync', {
                                    symbol: p.symbol, slOrderId: slOrder.orderId
                                });
                                const updated = updatePosition(existing, {
                                    slOrderId: slOrder.orderId,
                                    stopLoss: Number(slOrder.triggerPrice || slOrder.price),
                                    exchangeSlActive: true
                                });
                                await this._db.updatePosition(updated);
                                this._replace(updated);
                            }
                        } catch (err) {
                            logger.debug('[PositionManager] SL restore skipped', { symbol: p.symbol, message: err.message });
                        }
                    }
                } else {
                    // Restore position entirely from exchange (orphaned trade after bot restart/kill)
                    logger.info('[PositionManager] syncing missing position from exchange', { symbol: p.symbol, side: p.side });

                    let slOrderId = null;
                    let stopLoss = null;
                    if (this._broker.mode === 'live') {
                        try {
                            const openOrders = await this._broker._client.getOpenOrders(p.symbol);
                            const slOrder = openOrders.find(o => o.clientOrderId?.startsWith('sl_'));
                            if (slOrder) {
                                slOrderId = slOrder.orderId;
                                stopLoss = Number(slOrder.triggerPrice || slOrder.price);
                                logger.info('[PositionManager] restored SL from exchange for orphaned position', {
                                    symbol: p.symbol, slOrderId, stopLoss
                                });
                            }
                        } catch (err) {
                            logger.debug('[PositionManager] SL restore failed for orphaned position', { symbol: p.symbol, message: err.message });
                        }
                    }

                    const pos = createPosition({
                        positionId: `sync_${p.symbol}_${p.side}_${Date.now()}`,
                        symbol: p.symbol,
                        side: p.side,
                        entryPrice: p.entryPrice,
                        totalQuantity: p.totalQuantity,
                        remainingQuantity: p.remainingQuantity,
                        leverage: p.leverage,
                        stopLoss,
                        slOrderId,
                        exchangeSlActive: Boolean(stopLoss && this._broker.mode === 'live'),
                        mode: this._broker.mode
                    });
                    this._push(pos);
                    // Note: we don't insert into DB here as it might be a temporary sync object.
                    // Real trades should already be in DB or will be synced back.
                }
            }

            // 2. Remove positions that are no longer on exchange
            for (const pos of currentPositions) {
                const stillExists = remotePositions.find(p => p.symbol === pos.symbol && p.side.toLowerCase() === pos.side.toLowerCase());
                if (!stillExists) {
                    logger.info('[PositionManager] position closed externally, removing from local state', { symbol: pos.symbol, side: pos.side });
                    const arr = (this._positions.get(pos.symbol) || []).filter(p => p.positionId !== pos.positionId);
                    this._positions.set(pos.symbol, arr);
                    
                    const updated = updatePosition(pos, { status: 'CLOSED', closedAt: Date.now(), remainingQuantity: 0 });
                    await this._db.updatePosition(updated);
                }
            }
        } catch (err) {
            logger.warn('[PositionManager] exchange sync failed', { message: err.message });
        }
    }

    /**
     * C8 Phase 2: Polls open WEEX orders to see if our TP orders were filled.
     * Starts on app boot for LiveBroker mode.
     */
    startTpPolling() {
        if (this._broker.mode !== 'live') return;
        if (this._pollTimer) return;
        
        logger.info('[PositionManager] starting TP polling', { interval: this._pollIntervalMs });
        this._pollTimer = setInterval(() => this._pollTpStatus(), this._pollIntervalMs);
        // unref() so an orphan timer never holds the event loop open — lets
        // Jest teardown + graceful shutdown exit cleanly even if stopTpPolling()
        // isn't called explicitly.
        if (typeof this._pollTimer?.unref === 'function') this._pollTimer.unref();
    }

    stopTpPolling() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
    }

    async _pollTpStatus() {
        if (this._broker.mode !== 'live') return;
        const openPos = this.getOpen();
        if (openPos.length === 0) return;

        for (const p of openPos) {
            if (!p.exchangeTpActive) continue;
            
            await this._lock(p.symbol).runExclusive(async () => {
                // Re-fetch between each TP check — _checkTpFill mutates in-memory
                // and DB state. Without refreshing, status/order-id gates for TP2/TP3
                // see stale values from before TP1 was consumed.
                const latest = () => (this._positions.get(p.symbol) || [])
                    .find((x) => x.positionId === p.positionId);

                let current = latest();
                if (!current || current.status === 'CLOSED') return;
                if (current.tp1OrderId) await this._checkTpFill(current, 1, current.tp1OrderId, 0.5);

                current = latest();
                if (!current || current.status === 'CLOSED') return;
                if (current.tp2OrderId && current.status === 'PARTIAL') {
                    await this._checkTpFill(current, 2, current.tp2OrderId, 0.6);
                }

                current = latest();
                if (!current || current.status === 'CLOSED') return;
                if (current.tp3OrderId && current.status === 'PARTIAL') {
                    await this._checkTpFill(current, 3, current.tp3OrderId, 1.0);
                }
            });
        }
    }

    async _checkTpFill(position, level, orderId, fraction) {
        try {
            // C1 fix: go through public broker surface, not _client.
            if (typeof this._broker.getOrder !== 'function') return;

            // C8 Phase 2 fix: prevent polling if orderId is empty or not yet a numeric string
            // while we only have bot-prefixed client ids.
            if (!orderId || String(orderId).startsWith('tp_') || String(orderId).startsWith('sl_')) {
                // If it's a bot ID, we check if it's still in open algo orders instead of direct query
                // to avoid "Parameter orderId cannot be empty" error.
                const openAlgo = await this._broker._client.getAlgoOpenOrders(position.symbol);
                const stillOpen = openAlgo.some(o => (o.clientAlgoId || o.clientOrderId) === orderId);
                
                if (!stillOpen) {
                    // If not in open algo orders, it might be filled or cancelled.
                    // We trigger a full sync to be sure.
                    logger.info('[PositionManager] Algo order no longer in open list, triggering sync', { symbol: position.symbol, orderId });
                    await this.syncWithExchange();
                }
                return;
            }

            const order = await this._broker.getOrder({ symbol: position.symbol, orderId });
            if (!order) return;
            const status = String(order.status || order.state || '').toUpperCase();

            // C8 Phase 2 fix (M1): treat user-cancelled/expired orders as "no longer on
            // exchange" — clear the tracked id so _evaluateExits can take over locally.
            if (status === 'CANCELLED' || status === 'CANCELED' || status === 'EXPIRED' || status === 'REJECTED') {
                logger.warn(`[PositionManager] TP${level} ${status} on exchange — releasing tracked orderId`, {
                    symbol: position.symbol, orderId
                });
                const releaseUpdates = {};
                if (level === 1) releaseUpdates.tp1OrderId = null;
                else if (level === 2) releaseUpdates.tp2OrderId = null;
                else if (level === 3) releaseUpdates.tp3OrderId = null;
                const released = updatePosition(position, releaseUpdates);
                await this._db.updatePosition(released);
                this._replace(released);
                return;
            }

            if (status !== 'FILLED') return;

            logger.info(`[PositionManager] TP${level} FILLED on exchange`, { symbol: position.symbol, orderId });

            // C4 fix: prefer executedQty from exchange over fraction-guess — this is
            // the authoritative close quantity and stays correct when risk percents
            // in config drift from the ones used when the ladder was placed.
            const executedQty = Number(order.executedQty ?? order.executedQuantity ?? order.cumQuote ?? 0);
            const fallbackQty = position.remainingQuantity * fraction;
            const closeQtyRaw = Number.isFinite(executedQty) && executedQty > 0 ? executedQty : fallbackQty;
            // Clamp to what's actually remaining to avoid negative remaining on rounding drift.
            const closeQty = Math.min(Math.max(closeQtyRaw, 0), position.remainingQuantity);
            const remaining = position.remainingQuantity - closeQty;

            const fillPrice = Number(
                order.avgPrice ?? order.price ??
                (level === 1 ? position.tp1Price : level === 2 ? position.tp2Price : position.tp3Price)
            );

            // C2 fix: subtract taker fee, matching LiveBroker.closeMarket accounting.
            const grossPnl = position.side === 'long'
                ? (fillPrice - position.entryPrice) * closeQty
                : (position.entryPrice - fillPrice) * closeQty;
            const takerFeeRate = this._broker._takerFeeRate ?? 0.0004;
            const fee = Math.abs(fillPrice * closeQty) * takerFeeRate;
            const netPnl = grossPnl - fee;

            const updates = {
                remainingQuantity: remaining,
                realizedPnl: position.realizedPnl + netPnl,
                status: remaining > 0 ? 'PARTIAL' : 'CLOSED',
                closedAt: remaining > 0 ? null : Date.now()
            };

            // C5 fix: null out the consumed tpNPrice too so a later mutation to
            // slMovedToBreakeven can't accidentally re-arm the local exit branch.
            if (level === 1) {
                updates.tp1OrderId = null;
                updates.tp1Price = null;
                // Bug 2 fix: do NOT set slMovedToBreakeven / stopLoss here.
                // Persist them only AFTER modifySlTp on the exchange succeeds
                // (see block below). Otherwise the DB can drift ahead of the
                // exchange state and we'll never retry the move.
            } else if (level === 2) {
                updates.tp2OrderId = null;
                updates.tp2Price = null;
            } else if (level === 3) {
                updates.tp3OrderId = null;
                updates.tp3Price = null;
            }

            // M6 fix: refresh exchangeTpActive flag once all ladder orders consumed.
            const remainingTpIds = [
                level === 1 ? null : position.tp1OrderId,
                level === 2 ? null : position.tp2OrderId,
                level === 3 ? null : position.tp3OrderId
            ];
            updates.exchangeTpActive = remainingTpIds.some((id) => Boolean(id));

            const updated = updatePosition(position, updates);
            await this._db.updatePosition(updated);
            await this._db.insertPartialClose({
                positionId: position.positionId,
                tpLevel: level,
                price: fillPrice,
                quantity: closeQty,
                pnl: netPnl,
                orderId: order.orderId || orderId,
                closedAt: Date.now()
            });
            this._replace(updated);

            if (this._riskGuard && Number.isFinite(netPnl) && netPnl !== 0) {
                try { await this._riskGuard.recordRealisedPnl(netPnl); }
                catch (err) { logger.error('[PositionManager] riskGuard.recordRealisedPnl failed (poll path)', { message: err.message }); }
            }

            if (remaining <= 0) {
                // Full close through the ladder — drop from in-memory map.
                const arr = (this._positions.get(position.symbol) || [])
                    .filter((p) => p.positionId !== position.positionId);
                this._positions.set(position.symbol, arr);
                this._onEvent('positionClosed', { position: updated, reason: `TP${level}:exchange`, pnl: netPnl });
            } else {
                this._onEvent('partialClose', { position: updated, level, pnl: netPnl });
            }

            // C3 fix: breakeven move goes through public modifySlTp with the
            // tracked slOrderId so the fallback cancels ONLY the old SL.
            if (level === 1 && position.slOrderId && typeof this._broker.modifySlTp === 'function') {
                try {
                    // Bug 2 fix: Safety distance check for breakeven
                    // Use a 0.1% buffer. We need markPrice here. 
                    // Since _checkTpFill doesn't have markPrice, we use fillPrice as approximation.
                    const buffer = fillPrice * 0.001;
                    const isLongValid = position.side === 'long' && position.entryPrice < (fillPrice - buffer);
                    const isShortValid = position.side === 'short' && position.entryPrice > (fillPrice + buffer);

                    if (isLongValid || isShortValid) {
                        logger.info('[PositionManager] Moving exchange SL to breakeven (poll path)', {
                            symbol: position.symbol, slOrderId: position.slOrderId, entryPrice: position.entryPrice
                        });
                        const res = await this._broker.modifySlTp({
                            symbol: position.symbol,
                            orderId: position.slOrderId,
                            slTriggerPrice: position.entryPrice
                        });

                        // Bug 2 fix: only now — after the exchange confirms — mark
                        // the breakeven move in DB / in-memory state. If modifySlTp
                        // failed or was skipped, the next poll tick will retry because
                        // slMovedToBreakeven is still false.
                        if (res && res.success) {
                            const currentRef = (this._positions.get(position.symbol) || [])
                                .find(x => x.positionId === position.positionId) || updated;
                            const patch = {
                                slMovedToBreakeven: true,
                                stopLoss: position.entryPrice
                            };
                            if (res.mode === 'replace' && res.slOrderId) {
                                logger.info('[PositionManager] Updating slOrderId after polling replace-move', {
                                    symbol: position.symbol, old: position.slOrderId, new: res.slOrderId
                                });
                                patch.slOrderId = res.slOrderId;
                            }
                            const synced = updatePosition(currentRef, patch);
                            await this._db.updatePosition(synced);
                            this._replace(synced);
                        } else {
                            logger.warn('[PositionManager] modifySlTp did not confirm success; will retry', {
                                symbol: position.symbol, res
                            });
                        }
                    } else {
                        logger.warn('[PositionManager] Breakeven move skipped (poll path): price too close', {
                            symbol: position.symbol, entryPrice: position.entryPrice, fillPrice
                        });
                    }
                } catch (err) {
                    logger.error('[PositionManager] Failed to move exchange SL to breakeven (poll path)', {
                        symbol: position.symbol, message: err.message
                    });
                }
            }
        } catch (err) {
            logger.debug(`[PositionManager] checkTpFill failed`, { orderId, message: err.message });
        }
    }

    _rowToPosition(r) {
        return createPosition({
            positionId: r.position_id,
            symbol: r.symbol,
            side: r.side,
            entryPrice: r.entry_price,
            totalQuantity: r.total_quantity,
            remainingQuantity: r.remaining_quantity,
            leverage: r.leverage,
            stopLoss: r.stop_loss,
            tp1Price: r.tp1_price,
            tp2Price: r.tp2_price,
            tp3Price: r.tp3_price,
            status: r.status,
            realizedPnl: r.realized_pnl,
            slMovedToBreakeven: Boolean(r.sl_moved_to_breakeven),
            mode: r.mode,
            openedAt: r.opened_at,
            closedAt: r.closed_at,
            entryOrderId: r.entry_order_id,
            // C8 Phase 1: exchange-side SL tracking.
            slOrderId: r.sl_order_id ?? null,
            exchangeSlActive: r.mode === 'live' && r.stop_loss != null,
            // C8 Phase 2: exchange-side TP tracking.
            tp1OrderId: r.tp1_order_id ?? null,
            tp2OrderId: r.tp2_order_id ?? null,
            tp3OrderId: r.tp3_order_id ?? null,
            exchangeTpActive: Boolean(r.tp1_order_id || r.tp2_order_id || r.tp3_order_id),
            decisionId: r.decision_id
        });
    }

    _lock(symbol) {
        const key = this._userId ? `${this._userId}:${symbol}` : symbol;
        let m = this._locks.get(key);
        if (!m) {
            m = new Mutex();
            this._locks.set(key, m);
        }
        return m;
    }

    _push(p) {
        const arr = this._positions.get(p.symbol) || [];
        arr.push(p);
        this._positions.set(p.symbol, arr);
    }

    _replace(p) {
        const arr = this._positions.get(p.symbol) || [];
        const idx = arr.findIndex((x) => x.positionId === p.positionId);
        if (idx >= 0) arr[idx] = p;
        this._positions.set(p.symbol, arr);
    }

    getOpen(symbol) {
        if (symbol) return [...(this._positions.get(symbol) || [])];
        return [].concat(...this._positions.values());
    }

    getAllOpenCount() {
        let n = 0;
        for (const arr of this._positions.values()) n += arr.length;
        return n;
    }

    /**
     * Open a new position atomically.
     */
    async open({ symbol, direction, markPrice, sizing, decisionId }) {
        return this._lock(symbol).runExclusive(async () => {
            // --- ONE POSITION AT A TIME ---
            const existing = this._positions.get(symbol) || [];
            if (existing.length > 0) {
                logger.info(`[PositionManager] already have an active position for ${symbol} — ignoring new ${direction} signal until current trade is closed.`);
                return;
            }

            const side = direction === 'LONG' ? 'long' : 'short';

            const precision = getAssetPrecision(symbol);
            
            const roundQty = (q) => {
                return Number(q.toFixed(precision.qty));
            };
            const roundPrice = (p) => {
                return Number(p.toFixed(precision.price));
            };

            const roundedQty = roundQty(sizing.quantity);

            // Pre-round risk params
            if (sizing.stopLoss) sizing.stopLoss = roundPrice(sizing.stopLoss);
            if (sizing.takeProfits) {
                sizing.takeProfits = sizing.takeProfits.map(tp => ({
                    ...tp,
                    price: roundPrice(tp.price)
                }));
            }

            let fill;
            try {


                if (roundedQty <= 0) {
                    throw new Error(`Quantity too small after rounding: ${sizing.quantity}`);
                }
                const effectiveNotional = roundedQty * (markPrice || sizing.entryPrice || 0);
                if (effectiveNotional < this._minNotionalUsd) {
                    throw new Error(
                        `Notional $${effectiveNotional.toFixed(2)} below exchange minimum $${this._minNotionalUsd} (symbol ${symbol}, qty ${roundedQty}, price ${markPrice})`
                    );
                }

                // C8 Phase 1: pass SL/TP to broker → exchange-side attached SL protects
                // the position even if the bot dies. TP1 is attached as well; TP2/TP3 ladder
                // remains locally managed until Phase 2 adds reduce-only limit orders.
                fill = await this._broker.placeMarketOrder({
                    symbol,
                    side,
                    quantity: roundedQty,
                    price: markPrice,
                    leverage: sizing.leverage,
                    stopLoss: sizing.stopLoss
                    // tpPrice is REMOVED to allow partial ladder closes
                });
                sizing.quantity = roundedQty; // Update sizing with actual used quantity
            } catch (err) {
                logger.error('[PositionManager] open failed', { symbol, message: err.message });
                await this._db.insertRiskEvent({
                    eventType: 'OPEN_FAILED', symbol, reason: err.message, meta: { direction }
                });
                this._onEvent('openFailed', { symbol, direction, reason: err.message });
                return null;
            }

            // C8 Phase 1: exchangeSlActive=true when live broker accepted SL on entry.
            const exchangeSlActive = this._broker.mode === 'live' && Number.isFinite(sizing.stopLoss);
            
            // C8 Phase 2: place TP ladder (reduce-only LIMITs) on exchange
            let tpOrderIds = { tp1OrderId: null, tp2OrderId: null, tp3OrderId: null };
            let exchangeTpActive = false;
            
            if (this._broker.mode === 'live' && typeof this._broker.placeTpLadder === 'function' && sizing.takeProfits?.length > 0) {
                const tp1Pct = (this._config.risk?.tp1ClosePercent || 50) / 100;
                const tp2Pct = (this._config.risk?.tp2ClosePercent || 30) / 100;
                const tp3Pct = (this._config.risk?.tp3ClosePercent || 20) / 100;
                
                tpOrderIds = await this._broker.placeTpLadder({
                    symbol,
                    side,
                    totalQty: sizing.quantity,
                    tp1Price: sizing.takeProfits[0]?.price,
                    tp2Price: sizing.takeProfits[1]?.price,
                    tp3Price: sizing.takeProfits[2]?.price,
                    tp1Pct: roundQty(sizing.quantity * tp1Pct) / sizing.quantity,
                    tp2Pct: roundQty(sizing.quantity * tp2Pct) / sizing.quantity,
                    tp3Pct: roundQty(sizing.quantity * tp3Pct) / sizing.quantity
                });
                exchangeTpActive = Boolean(tpOrderIds.tp1OrderId || tpOrderIds.tp2OrderId || tpOrderIds.tp3OrderId);
            }

            const position = createPosition({
                symbol,
                side,
                entryPrice: fill.price || markPrice,
                totalQuantity: sizing.quantity,
                leverage: sizing.leverage,
                stopLoss: sizing.stopLoss,
                tp1Price: sizing.takeProfits[0]?.price,
                tp2Price: sizing.takeProfits[1]?.price,
                tp3Price: sizing.takeProfits[2]?.price,
                entryOrderId: fill.orderId,
                slOrderId: fill.slOrderId ?? null,
                exchangeSlActive,
                tp1OrderId: tpOrderIds.tp1OrderId,
                tp2OrderId: tpOrderIds.tp2OrderId,
                tp3OrderId: tpOrderIds.tp3OrderId,
                exchangeTpActive,
                decisionId,
                mode: this._broker.mode,
                userId: this._userId
            });

            await this._db.insertPosition(position);
            this._push(position);
            this._onEvent('positionOpened', { position });
            return position;
        });
    }

    async onMarkPrice(symbol, markPrice) {
        const positions = this._positions.get(symbol);
        if (!positions || positions.length === 0) return;

        await this._lock(symbol).runExclusive(async () => {
            const snapshot = [...(this._positions.get(symbol) || [])];
            for (const p of snapshot) {
                if (p.status === 'CLOSED' || p.status === 'CANCELLED' || p.status === 'LIQUIDATED') continue;
                await this._evaluateExits(p, markPrice);
            }
        });
    }

    async _evaluateExits(position, markPrice) {
        const { side, stopLoss, tp1Price, tp2Price, tp3Price, status, exchangeSlActive } = position;
        const tpHit = (target) => side === 'long' ? markPrice >= target : markPrice <= target;

        const slHit = stopLoss && (side === 'long' ? markPrice <= stopLoss : markPrice >= stopLoss);
        if (slHit) {
            // C8 Phase 1: when exchange-side SL is active (live mode with stopLoss attached
            // on entry order), skip local SL close — WEEX will trigger it atomically and we'll
            // reconcile via syncWithExchange / WS fill events. Double-close would race and
            // return WEEX error "position not found". Paper mode always closes locally.
            if (exchangeSlActive) {
                logger.debug('[PositionManager] SL hit but exchangeSlActive=true, deferring to exchange', {
                    symbol: position.symbol, markPrice, stopLoss
                });
                return;
            }
            await this._closeFull(position, markPrice, 'SL');
            return;
        }
        
        // C8 Phase 2: If exchange TP orders are active, defer to them (avoids race condition 
        // where bot closes locally but exchange also fills the limit order).
        // Paper mode always processes TPs locally.
        
        const shouldCheckTP1 = (status === 'OPEN' || (status === 'PARTIAL' && !position.slMovedToBreakeven));

        if (shouldCheckTP1 && tp1Price && tpHit(tp1Price)) {
            if (position.tp1OrderId) {
                logger.debug('[PositionManager] TP1 hit but tp1OrderId exists, deferring to exchange', { symbol: position.symbol, tp1Price });
                return;
            }
            await this._partialClose(position, markPrice, 1, 0.5);
            return;
        }
        if (status === 'PARTIAL' && tp2Price && tpHit(tp2Price) && position.remainingQuantity > position.totalQuantity * 0.21) {
            if (position.tp2OrderId) {
                logger.debug('[PositionManager] TP2 hit but tp2OrderId exists, deferring to exchange', { symbol: position.symbol, tp2Price });
                return;
            }
            await this._partialClose(position, markPrice, 2, 0.6);
            return;
        }
        if (status === 'PARTIAL' && tp3Price && tpHit(tp3Price)) {
            if (position.tp3OrderId) {
                logger.debug('[PositionManager] TP3 hit but tp3OrderId exists, deferring to exchange', { symbol: position.symbol, tp3Price });
                return;
            }
            await this._closeFull(position, markPrice, 'TP3');
        }
    }

    async _partialClose(position, markPrice, level, fractionOfRemaining) {
        // Get symbol-specific step size for correct rounding
        const stepSizeMap = {
            'BTCUSDT': 0.001,
            'ETHUSDT': 0.001,
            'SOLUSDT': 0.1,
            'BNBUSDT': 0.01,
            'XRPUSDT': 1,
            'ADAUSDT': 10,
            'XAUTUSDT': 0.01
        };
        const stepSize = stepSizeMap[position.symbol] || 0.001;
        
        let closeQty;
        const rawQty = position.remainingQuantity * fractionOfRemaining;
        if (stepSize >= 1) {
            closeQty = Math.floor(rawQty / stepSize) * stepSize;
        } else {
            const precision = Math.log10(1/stepSize);
            const factor = Math.pow(10, precision);
            closeQty = Math.floor(rawQty * factor) / factor;
        }
        
        if (closeQty <= 0) return;
        
        let fill;
        try {
            // C8 Phase 2 fix (C3): if we have the specific TP order id for this level,
            // cancel ONLY that one to free the quantity for our market close, leaving
            // the remaining TP levels and the SL intact. Falls back to tp_-prefix
            // scan when the id is not tracked (e.g. ladder placed pre-upgrade).
            if (this._broker.mode === 'live' && typeof this._broker.cancelOrderById === 'function') {
                const levelOrderId = level === 1 ? position.tp1OrderId
                                   : level === 2 ? position.tp2OrderId
                                   : position.tp3OrderId;
                if (levelOrderId) {
                    try {
                        logger.info('[PositionManager] cancelling specific TP order before partial close', {
                            symbol: position.symbol, level, orderId: levelOrderId
                        });
                        await this._broker.cancelOrderById({ symbol: position.symbol, orderId: levelOrderId });
                    } catch (cancelErr) {
                        logger.debug('[PositionManager] cancel-by-orderId skipped', { message: cancelErr.message });
                    }
                } else if (typeof this._broker.cancelAllForSymbol === 'function') {
                    logger.info('[PositionManager] cancelling tp_ orders before partial close (no id tracked)', { symbol: position.symbol });
                    await this._broker.cancelAllForSymbol(position.symbol, { prefixes: ['tp_'] });
                }
            }

            fill = await this._broker.closeMarket({
                symbol: position.symbol,
                side: position.side,
                quantity: closeQty,
                entryPrice: position.entryPrice,
                markPrice
            });
        } catch (err) {
            // Exchange-side SL may have fired between our TP trigger and this close call.
            // Treat as terminal close: wipe local state, reconcile via sync later.
            if (_isAlreadyClosedError(err)) {
                logger.warn('[PositionManager] partial close skipped, position already closed on exchange', {
                    symbol: position.symbol, level, message: err.message
                });
                const updated = updatePosition(position, {
                    remainingQuantity: 0, status: 'CLOSED', closedAt: Date.now()
                });
                await this._db.updatePosition(updated);
                const arr = (this._positions.get(position.symbol) || [])
                    .filter((p) => p.positionId !== position.positionId);
                this._positions.set(position.symbol, arr);
                this._onEvent('positionClosed', { position: updated, reason: `TP${level}:exchange_prior`, pnl: null });
                return;
            }
            throw err;
        }

        const remaining = position.remainingQuantity - closeQty;
        // Bug 2 fix: do NOT set slMovedToBreakeven / stopLoss optimistically.
        // They are persisted below only after the exchange confirms the SL move.
        const updated = updatePosition(position, {
            remainingQuantity: remaining,
            realizedPnl: position.realizedPnl + (fill.pnl || 0),
            status: remaining > 0 ? 'PARTIAL' : 'CLOSED',
            closedAt: remaining > 0 ? null : Date.now()
        });

        await this._db.updatePosition(updated);
        await this._db.insertPartialClose({
            positionId: position.positionId,
            tpLevel: level,
            price: fill.price,
            quantity: closeQty,
            pnl: fill.pnl || 0,
            orderId: fill.orderId,
            closedAt: Date.now()
        });
        this._replace(updated);

        // C8 Phase 2: Move SL to breakeven on exchange if TP1 hit.
        // Pass the existing slOrderId so the fallback cancels the specific SL
        // and does NOT wipe the remaining TP ladder (fix C3).
        if (level === 1 && this._broker.mode === 'live') {
            try {
                // Bug 2 fix: Ensure new SL (entryPrice) is valid relative to markPrice.
                // For LONG: SL must be < current price. For SHORT: SL must be > current price.
                // We add a 0.1% buffer to avoid tight reject.
                const buffer = markPrice * 0.001;
                const isLongValid = position.side === 'long' && position.entryPrice < (markPrice - buffer);
                const isShortValid = position.side === 'short' && position.entryPrice > (markPrice + buffer);

                if (isLongValid || isShortValid) {
                    logger.info('[PositionManager] Moving SL to breakeven after TP1', {
                        symbol: position.symbol, entryPrice: position.entryPrice, markPrice
                    });
                    const res = await this._broker.modifySlTp({
                        symbol: position.symbol,
                        orderId: position.slOrderId,
                        slTriggerPrice: position.entryPrice
                    });

                    // Bug 2 fix: only mark breakeven in DB / memory AFTER exchange
                    // confirmed the move. If it failed we leave slMovedToBreakeven=false
                    // so a subsequent retry path can try again.
                    if (res && res.success) {
                        const currentRef = (this._positions.get(position.symbol) || [])
                            .find(x => x.positionId === position.positionId) || updated;
                        const patch = {
                            slMovedToBreakeven: true,
                            stopLoss: position.entryPrice
                        };
                        if (res.mode === 'replace' && res.slOrderId) {
                            logger.info('[PositionManager] Updating slOrderId after replace-move', {
                                symbol: position.symbol, old: position.slOrderId, new: res.slOrderId
                            });
                            patch.slOrderId = res.slOrderId;
                        }
                        const synced = updatePosition(currentRef, patch);
                        await this._db.updatePosition(synced);
                        this._replace(synced);
                    } else {
                        logger.warn('[PositionManager] modifySlTp did not confirm success; breakeven not persisted', {
                            symbol: position.symbol, res
                        });
                    }
                } else {
                    logger.warn('[PositionManager] Breakeven move skipped: price too close to entry or already in loss', {
                        symbol: position.symbol, entryPrice: position.entryPrice, markPrice
                    });
                }
            } catch (err) {
                logger.error('[PositionManager] Failed to move SL to breakeven', { symbol: position.symbol, message: err.message });
            }
        }

        if (this._riskGuard && Number.isFinite(fill.pnl) && fill.pnl !== 0) {
            try { await this._riskGuard.recordRealisedPnl(fill.pnl); }
            catch (err) { logger.error('[PositionManager] riskGuard.recordRealisedPnl failed', { message: err.message }); }
        }
        this._onEvent('partialClose', { position: updated, level, pnl: fill.pnl });
    }

    async _closeFull(position, markPrice, reason) {
        // C8 Phase 2: Before sending market close, cancel any pending TP/SL child orders
        // to free up margin and prevent them from remaining open.
        if (this._broker.mode === 'live' && typeof this._broker.cancelAllForSymbol === 'function') {
            try {
                await this._broker.cancelAllForSymbol(position.symbol);
            } catch (err) {
                logger.warn('[PositionManager] failed to cancel child orders before full close', { symbol: position.symbol, message: err.message });
            }
        }

        let fill;
        try {
            fill = await this._broker.closeMarket({
                symbol: position.symbol,
                side: position.side,
                quantity: position.remainingQuantity,
                entryPrice: position.entryPrice,
                markPrice
            });
        } catch (err) {
            // C8 Phase 1: exchange may have already closed the position (via attached SL
            // firing ahead of us). Treat "position not found / already closed" errors as
            // terminal and just reconcile local state. Any other error is rethrown.
            if (_isAlreadyClosedError(err)) {
                logger.warn('[PositionManager] close skipped, position already closed on exchange', {
                    symbol: position.symbol, reason, message: err.message
                });
                const updated = updatePosition(position, {
                    remainingQuantity: 0, status: 'CLOSED', closedAt: Date.now()
                });
                await this._db.updatePosition(updated);
                const arr = (this._positions.get(position.symbol) || [])
                    .filter((p) => p.positionId !== position.positionId);
                this._positions.set(position.symbol, arr);
                this._onEvent('positionClosed', { position: updated, reason: `${reason}:exchange_prior`, pnl: null });
                return;
            }
            throw err;
        }
        const updated = updatePosition(position, {
            remainingQuantity: 0,
            realizedPnl: position.realizedPnl + (fill.pnl || 0),
            status: 'CLOSED',
            closedAt: Date.now()
        });
        await this._db.updatePosition(updated);
        const arr = (this._positions.get(position.symbol) || []).filter((p) => p.positionId !== position.positionId);
        this._positions.set(position.symbol, arr);
        if (this._riskGuard && Number.isFinite(fill.pnl) && fill.pnl !== 0) {
            try { await this._riskGuard.recordRealisedPnl(fill.pnl); }
            catch (err) { logger.error('[PositionManager] riskGuard.recordRealisedPnl failed', { message: err.message }); }
        }
        this._onEvent('positionClosed', { position: updated, reason, pnl: fill.pnl });
    }

    async forceCloseAll(reason = 'manual') {
        const all = this.getOpen();
        for (const p of all) {
            // Safety: Never close positions that were imported from exchange (manual trades)
            // unless the reason is explicitly 'manual_full_reset' or similar.
            if (p.positionId.startsWith('sync_') && reason !== 'manual_full_reset') {
                logger.info('[PositionManager] skipping forceClose for external/manual position', { symbol: p.symbol, positionId: p.positionId });
                continue;
            }

            await this._lock(p.symbol).runExclusive(async () => {
                await this._closeFull(p, p.entryPrice, reason);
            });
        }
    }

    /**
     * Close a single position by its id at market (mark-price = entryPrice fallback).
     * Used by emergency-close flows and Telegram /close.
     * @param {string} positionId
     * @param {string} [reason='manual']
     * @returns {Promise<{success:boolean, position?:Object, error?:string}>}
     */
    async closePosition(positionId, reason = 'manual') {
        const all = this.getOpen();
        const target = all.find((p) => p.positionId === positionId);
        if (!target) {
            return { success: false, error: `position ${positionId} not found or already closed` };
        }
        try {
            await this._lock(target.symbol).runExclusive(async () => {
                await this._closeFull(target, target.entryPrice, reason);
            });
            return { success: true, position: target };
        } catch (err) {
            logger.error('[PositionManager] closePosition failed', { positionId, message: err.message });
            return { success: false, error: err.message };
        }
    }

    computeTotalUnrealizedPnl(priceFn) {
        let total = 0;
        for (const arr of this._positions.values()) {
            for (const p of arr) {
                const price = priceFn(p.symbol);
                if (Number.isFinite(price)) total += computeUnrealizedPnl(p, price);
            }
        }
        return total;
    }
}

module.exports = { PositionManager };
