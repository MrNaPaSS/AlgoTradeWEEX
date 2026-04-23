const { nanoid } = require('nanoid');
const logger = require('../utils/logger');

/**
 * PaperBroker — simulates WEEX futures execution with deterministic slippage
 * and commission. Maintains a virtual USDT balance. Same public surface as
 * LiveBroker so the orchestrator is agnostic.
 */
class PaperBroker {
    /**
     * @param {Object} opts
     * @param {number} opts.startingBalanceUsd
     * @param {number} [opts.slippageBps=3]      3 bps = 0.03%
     * @param {number} [opts.takerFeeBps=6]      WEEX taker ≈ 0.06%
     */
    constructor({ startingBalanceUsd, slippageBps = 3, takerFeeBps = 6 } = {}) {
        this._balance = startingBalanceUsd;
        this._startingBalance = startingBalanceUsd;
        this._slippageBps = slippageBps;
        this._feeBps = takerFeeBps;
        this._fills = [];
    }

    get mode() {
        return 'paper';
    }

    getAvailableBalanceUsd() {
        return this._balance;
    }

    snapshot() {
        return {
            mode: this.mode,
            balanceUsd: Number(this._balance.toFixed(4)),
            startingBalanceUsd: this._startingBalance,
            fills: this._fills.length
        };
    }

    /**
     * Simulate opening a position at market price.
     * @param {{symbol:string, side:'long'|'short', quantity:number, price:number, leverage:number}} order
     */
    async placeMarketOrder(order) {
        const fillPrice = this._applySlippage(order.price, order.side, 'open');
        const notional = fillPrice * order.quantity;
        const margin = notional / order.leverage;
        const fee = notional * (this._feeBps / 10_000);

        if (margin + fee > this._balance) {
            throw new Error(`[PaperBroker] insufficient balance: need ${(margin + fee).toFixed(2)}, have ${this._balance.toFixed(2)}`);
        }

        this._balance -= fee;
        const orderId = `paper-${nanoid(10)}`;
        const fill = {
            orderId,
            symbol: order.symbol,
            side: order.side,
            action: 'open',
            quantity: order.quantity,
            price: fillPrice,
            fee,
            filledAt: Date.now()
        };
        this._fills.push(fill);
        logger.info('[PaperBroker] market open', fill);
        return fill;
    }

    /**
     * Simulate closing part of a position at market price.
     * Returns realised pnl after fees.
     */
    async closeMarket({ symbol, side, quantity, entryPrice, markPrice }) {
        const fillPrice = this._applySlippage(markPrice, side, 'close');
        const notional = fillPrice * quantity;
        const fee = notional * (this._feeBps / 10_000);

        const grossPnl = side === 'long'
            ? (fillPrice - entryPrice) * quantity
            : (entryPrice - fillPrice) * quantity;
        const netPnl = grossPnl - fee;

        this._balance += netPnl;
        const orderId = `paper-${nanoid(10)}`;
        const fill = {
            orderId,
            symbol,
            side,
            action: 'close',
            quantity,
            price: fillPrice,
            fee,
            pnl: netPnl,
            filledAt: Date.now()
        };
        this._fills.push(fill);
        logger.info('[PaperBroker] market close', fill);
        return fill;
    }

    /**
     * C8 Phase 2 (C1): parity stub — paper mode has no real exchange orders to
     * query. Returns null so callers skip polling branches gracefully.
     */
    async getOrder() { return null; }
    async cancelOrderById() { return null; }
    async cancelAllForSymbol() { return { cancelled: [], skipped: [] }; }
    async modifySlTp() { return null; }
    async placeTpLadder() { return { tp1OrderId: null, tp2OrderId: null, tp3OrderId: null }; }

    _applySlippage(price, side, action) {
        const bps = this._slippageBps / 10_000;
        if (action === 'open') {
            return side === 'long' ? price * (1 + bps) : price * (1 - bps);
        }
        return side === 'long' ? price * (1 - bps) : price * (1 + bps);
    }
}

module.exports = { PaperBroker };
