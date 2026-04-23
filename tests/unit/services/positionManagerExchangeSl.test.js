/**
 * C8 Phase 1 regression tests — exchange-side SL plumbing.
 *
 * Goals:
 *   1. PositionManager.open passes stopLoss / tpPrice to broker.
 *   2. Position gets exchangeSlActive=true in live mode with SL; false in paper.
 *   3. _evaluateExits skips local SL close when exchangeSlActive=true.
 *   4. Paper mode still closes locally on SL (no regression).
 *   5. _closeFull swallows "already closed" exchange errors gracefully.
 */

const { PositionManager } = require('../../../src/services/PositionManager');

// Silence logger — we only care about behavior.
jest.mock('../../../src/utils/logger', () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

/** Minimal in-memory DB stub matching the surface PositionManager uses. */
function makeDbStub() {
    const rows = [];
    return {
        getOpenPositions: jest.fn(() => []),
        insertPosition:   jest.fn((p) => rows.push(p)),
        updatePosition:   jest.fn(),
        insertPartialClose: jest.fn(),
        insertRiskEvent:  jest.fn(),
        _rows: rows
    };
}

function makeSizing(stopLoss = 29500, tp1 = 30500) {
    return {
        quantity: 0.1,
        notionalUsd: 3000,
        leverage: 5,
        stopLoss,
        entryPrice: 30000,
        takeProfits: [
            { price: tp1, closePercent: 50 },
            { price: 31000, closePercent: 30 },
            { price: 32000, closePercent: 20 }
        ]
    };
}

describe('PositionManager — C8 Phase 1 exchange-side SL', () => {
    test('live broker receives stopLoss and tpPrice from sizing', async () => {
        const broker = {
            mode: 'live',
            placeMarketOrder: jest.fn().mockResolvedValue({
                orderId: 'ord-1',
                slOrderId: 'sl-ord-1',
                price: 30000
            }),
            closeMarket: jest.fn()
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await pm.open({
            symbol: 'BTCUSDT',
            direction: 'LONG',
            markPrice: 30000,
            sizing: makeSizing(29500, 30500),
            decisionId: 'dec-1'
        });

        expect(broker.placeMarketOrder).toHaveBeenCalledTimes(1);
        const call = broker.placeMarketOrder.mock.calls[0][0];
        expect(call.stopLoss).toBe(29500);
        expect(call.tpPrice).toBe(30500);
        expect(call.side).toBe('long');
        expect(call.symbol).toBe('BTCUSDT');
    });

    test('paper broker still receives stopLoss/tpPrice (signature parity)', async () => {
        const broker = {
            mode: 'paper',
            placeMarketOrder: jest.fn().mockResolvedValue({
                orderId: 'paper-1',
                price: 30000
            }),
            closeMarket: jest.fn()
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await pm.open({
            symbol: 'BTCUSDT',
            direction: 'LONG',
            markPrice: 30000,
            sizing: makeSizing(29500, 30500),
            decisionId: 'dec-2'
        });

        expect(broker.placeMarketOrder).toHaveBeenCalledTimes(1);
        expect(broker.placeMarketOrder.mock.calls[0][0].stopLoss).toBe(29500);
    });

    test('live + stopLoss ⇒ position.exchangeSlActive=true', async () => {
        const broker = {
            mode: 'live',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'ord-2', price: 30000 }),
            closeMarket: jest.fn()
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        const pos = await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-3'
        });

        expect(pos).toBeTruthy();
        expect(pos.exchangeSlActive).toBe(true);
        expect(pos.stopLoss).toBe(29500);
    });

    test('paper mode ⇒ position.exchangeSlActive=false', async () => {
        const broker = {
            mode: 'paper',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'paper-1', price: 30000 }),
            closeMarket: jest.fn()
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        const pos = await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-4'
        });

        expect(pos.exchangeSlActive).toBe(false);
    });

    test('live + SL hit ⇒ _closeFull NOT called (deferred to exchange)', async () => {
        const broker = {
            mode: 'live',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'ord-5', price: 30000 }),
            closeMarket: jest.fn().mockResolvedValue({ orderId: 'c-1', pnl: -50 })
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-5'
        });

        // Simulate mark price crossing SL
        await pm.onMarkPrice('BTCUSDT', 29400);

        expect(broker.closeMarket).not.toHaveBeenCalled();
        // Position remains open locally; exchange is trusted to close it and
        // syncWithExchange will reconcile on next tick.
        expect(pm.getOpen('BTCUSDT')).toHaveLength(1);
    });

    test('paper + SL hit ⇒ _closeFull IS called locally (no regression)', async () => {
        const broker = {
            mode: 'paper',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'paper-6', price: 30000 }),
            closeMarket: jest.fn().mockResolvedValue({ orderId: 'paper-c-6', pnl: -50, price: 29400 })
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-6'
        });

        await pm.onMarkPrice('BTCUSDT', 29400);

        expect(broker.closeMarket).toHaveBeenCalledTimes(1);
        expect(pm.getOpen('BTCUSDT')).toHaveLength(0);
    });

    test('SHORT live + SL hit above entry ⇒ deferred to exchange', async () => {
        const broker = {
            mode: 'live',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'ord-7', price: 30000 }),
            closeMarket: jest.fn()
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        const sizing = makeSizing(30500, 29500); // SHORT SL is ABOVE entry
        await pm.open({
            symbol: 'BTCUSDT', direction: 'SHORT', markPrice: 30000,
            sizing, decisionId: 'dec-7'
        });

        await pm.onMarkPrice('BTCUSDT', 30600); // price spikes up, hits SHORT SL
        expect(broker.closeMarket).not.toHaveBeenCalled();
    });

    test('_closeFull swallows "position already closed" errors and wipes local state', async () => {
        const broker = {
            mode: 'paper', // use paper so the local SL branch actually runs _closeFull
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'paper-8', price: 30000 }),
            closeMarket: jest.fn().mockRejectedValue(new Error('position not found'))
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });
        const events = [];
        pm._onEvent = (evt, payload) => events.push({ evt, payload });

        await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-8'
        });

        await pm.onMarkPrice('BTCUSDT', 29400);

        expect(broker.closeMarket).toHaveBeenCalledTimes(1);
        expect(pm.getOpen('BTCUSDT')).toHaveLength(0);
        const closedEvt = events.find((e) => e.evt === 'positionClosed');
        expect(closedEvt).toBeTruthy();
        expect(closedEvt.payload.reason).toMatch(/exchange_prior/);
    });

    test('_closeFull rethrows non-"already closed" errors', async () => {
        const broker = {
            mode: 'paper',
            placeMarketOrder: jest.fn().mockResolvedValue({ orderId: 'paper-9', price: 30000 }),
            closeMarket: jest.fn().mockRejectedValue(new Error('rate limited 429'))
        };
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await pm.open({
            symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
            sizing: makeSizing(29500), decisionId: 'dec-9'
        });

        await expect(pm.onMarkPrice('BTCUSDT', 29400)).rejects.toThrow(/rate limited/);
    });
});
