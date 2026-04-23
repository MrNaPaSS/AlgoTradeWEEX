const { nanoid } = require('nanoid');

const VALID_SIDES = new Set(['long', 'short']);
const VALID_STATUSES = new Set(['OPEN', 'PARTIAL', 'CLOSED', 'LIQUIDATED', 'CANCELLED']);

/**
 * Build an immutable Position record.
 * @param {Object} input
 * @returns {import('./types').Position}
 */
function createPosition(input) {
    if (!VALID_SIDES.has(input.side)) {
        throw new TypeError(`[Position] side must be "long" or "short"`);
    }
    return Object.freeze({
        positionId: input.positionId || nanoid(12),
        symbol: input.symbol,
        side: input.side,
        entryPrice: input.entryPrice,
        totalQuantity: input.totalQuantity,
        remainingQuantity: input.remainingQuantity ?? input.totalQuantity,
        leverage: input.leverage,
        stopLoss: input.stopLoss,
        tp1Price: input.tp1Price,
        tp2Price: input.tp2Price,
        tp3Price: input.tp3Price,
        status: input.status || 'OPEN',
        realizedPnl: input.realizedPnl ?? 0,
        unrealizedPnl: input.unrealizedPnl ?? 0,
        slMovedToBreakeven: Boolean(input.slMovedToBreakeven),
        mode: input.mode,
        openedAt: input.openedAt || Date.now(),
        closedAt: input.closedAt,
        entryOrderId: input.entryOrderId,
        // C8 Phase 1: exchange-side SL tracking.
        slOrderId: input.slOrderId ?? null,
        exchangeSlActive: Boolean(input.exchangeSlActive),
        // C8 Phase 2: exchange-side TP ladder order IDs.
        tp1OrderId: input.tp1OrderId ?? null,
        tp2OrderId: input.tp2OrderId ?? null,
        tp3OrderId: input.tp3OrderId ?? null,
        // True when at least one TP order is placed on exchange (live mode).
        exchangeTpActive: Boolean(input.exchangeTpActive),
        decisionId: input.decisionId,
        userId: input.userId ?? null
    });
}

/** Immutable update helper — returns a new Position. */
function updatePosition(position, patch) {
    return createPosition({ ...position, ...patch });
}

/** Compute unrealized PnL given a mark price. */
function computeUnrealizedPnl(position, markPrice) {
    const { side, entryPrice, remainingQuantity } = position;
    const diff = side === 'long' ? markPrice - entryPrice : entryPrice - markPrice;
    return diff * remainingQuantity;
}

module.exports = {
    createPosition,
    updatePosition,
    computeUnrealizedPnl,
    VALID_SIDES,
    VALID_STATUSES
};
