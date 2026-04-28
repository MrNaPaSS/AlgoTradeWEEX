/**
 * C8 Phase 2 regression tests — TP polling and breakeven SL move.
 *
 * Goals covered:
 *   1. CANCELLED order on exchange releases tracked tpNOrderId (M1).
 *   2. TP1 FILLED preserves TP2/TP3 tracked ids (C3 regression).
 *   3. executedQty from exchange is used instead of fraction-guess (C4).
 *   4. taker fee subtracted from polling PnL (C2).
 *   5. tpNPrice is nulled after consume (C5).
 *   6. exchangeTpActive flips to false after last level consumed (M6).
 *   7. Breakeven SL move passes tracked slOrderId (C3).
 */

const { PositionManager } = require('../../../src/services/PositionManager');

jest.mock('../../../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

function makeDbStub() {
    return {
        getOpenPositions: jest.fn(() => []),
        insertPosition: jest.fn(),
        updatePosition: jest.fn(),
        insertPartialClose: jest.fn(),
        insertRiskEvent: jest.fn()
    };
}

function makeBroker(overrides = {}) {
    return {
        mode: 'live',
        _takerFeeRate: 0.0004,
        placeMarketOrder: jest.fn().mockImplementation((opts) => Promise.resolve({
            orderId: 'entry-1',
            slOrderId: opts.stopLoss ? 'sl-xyz' : null,
            price: opts.price || 30000
        })),
        placeTpLadder: jest.fn().mockResolvedValue({
            tp1OrderId: 'tp1-aaa', tp2OrderId: 'tp2-bbb', tp3OrderId: 'tp3-ccc'
        }),
        cancelAllForSymbol: jest.fn().mockResolvedValue({ cancelled: [], skipped: [] }),
        cancelOrderById: jest.fn().mockResolvedValue(null),
        closeMarket: jest.fn().mockResolvedValue({ pnl: 0, price: 30000 }),
        getOrder: jest.fn(),
        modifySlTp: jest.fn().mockResolvedValue({ success: true }),
        ...overrides
    };
}

function makeSizing() {
    return {
        quantity: 1.0,
        leverage: 5,
        stopLoss: 29500,
        entryPrice: 30000,
        takeProfits: [
            { price: 30500, closePercent: 50 },
            { price: 31000, closePercent: 30 },
            { price: 32000, closePercent: 20 }
        ]
    };
}

async function openWithLadder(pm) {
    return pm.open({
        symbol: 'BTCUSDT', direction: 'LONG', markPrice: 30000,
        sizing: makeSizing(), decisionId: 'dec-p'
    });
}

describe('PositionManager — C8 Phase 2 polling', () => {
    test('CANCELLED order releases tracked tp1OrderId (M1)', async () => {
        const broker = makeBroker();
        broker.getOrder.mockResolvedValue({ orderId: 'tp1-aaa', status: 'CANCELLED' });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        const pos = await openWithLadder(pm);
        expect(pos.tp1OrderId).toBe('tp1-aaa');

        await pm._pollTpStatus();

        const after = pm.getOpen('BTCUSDT')[0];
        expect(after.tp1OrderId).toBeNull();
        // TP2/TP3 still tracked
        expect(after.tp2OrderId).toBe('tp2-bbb');
        expect(after.tp3OrderId).toBe('tp3-ccc');
        // Position NOT closed, still OPEN
        expect(after.status).toBe('OPEN');
        // modifySlTp NOT called (cancel is not a fill)
        expect(broker.modifySlTp).not.toHaveBeenCalled();
    });

    test('TP1 FILLED preserves TP2/TP3 tracked ids (C3 regression)', async () => {
        const broker = makeBroker();
        broker.getOrder.mockImplementation(({ orderId }) => {
            if (orderId === 'tp1-aaa') {
                return Promise.resolve({
                    orderId, status: 'FILLED', avgPrice: 30500, executedQty: 0.5
                });
            }
            return Promise.resolve({ orderId, status: 'NEW' });
        });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openWithLadder(pm);
        await pm._pollTpStatus();

        const after = pm.getOpen('BTCUSDT')[0];
        expect(after.tp1OrderId).toBeNull();
        // CRITICAL: TP2/TP3 order ids MUST survive the breakeven move.
        expect(after.tp2OrderId).toBe('tp2-bbb');
        expect(after.tp3OrderId).toBe('tp3-ccc');
        expect(after.slMovedToBreakeven).toBe(true);
        expect(after.status).toBe('PARTIAL');
        // cancelAllForSymbol must NOT be called (C3 — no blanket wipe)
        expect(broker.cancelAllForSymbol).not.toHaveBeenCalled();
        // Breakeven modifySlTp called with tracked slOrderId
        expect(broker.modifySlTp).toHaveBeenCalledWith(expect.objectContaining({
            symbol: 'BTCUSDT', orderId: 'sl-xyz', slTriggerPrice: 30024
        }));
    });

    test('uses executedQty from exchange, not fraction-guess (C4)', async () => {
        const broker = makeBroker();
        // Exchange reports TP1 filled 0.4 BTC (not 0.5). TP2/TP3 still NEW.
        broker.getOrder.mockImplementation(({ orderId }) => {
            if (orderId === 'tp1-aaa') {
                return Promise.resolve({ orderId, status: 'FILLED', avgPrice: 30500, executedQty: 0.4 });
            }
            return Promise.resolve({ orderId, status: 'NEW' });
        });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openWithLadder(pm);
        await pm._pollTpStatus();

        const after = pm.getOpen('BTCUSDT')[0];
        // remainingQuantity should reflect the actual 0.4 fill, not 0.5.
        expect(after.remainingQuantity).toBeCloseTo(0.6, 5);
    });

    test('taker fee subtracted from polling PnL (C2)', async () => {
        const db = makeDbStub();
        const broker = makeBroker();
        broker.getOrder.mockImplementation(({ orderId }) => {
            if (orderId === 'tp1-aaa') {
                return Promise.resolve({ orderId, status: 'FILLED', avgPrice: 30500, executedQty: 0.5 });
            }
            return Promise.resolve({ orderId, status: 'NEW' });
        });
        const pm = new PositionManager({ database: db, broker });

        await openWithLadder(pm);
        await pm._pollTpStatus();

        // gross = (30500 - 30000) * 0.5 = 250
        // fee   = 30500 * 0.5 * 0.0004 = 6.1
        // net   = 243.9
        expect(db.insertPartialClose).toHaveBeenCalledWith(expect.objectContaining({
            tpLevel: 1,
            quantity: 0.5
        }));
        const call = db.insertPartialClose.mock.calls[0][0];
        expect(call.pnl).toBeCloseTo(243.9, 1);
    });

    test('tp1Price nulled after consume and exchangeTpActive stays true until last', async () => {
        const broker = makeBroker();
        broker.getOrder.mockImplementation(({ orderId }) => {
            if (orderId === 'tp1-aaa') {
                return Promise.resolve({ orderId, status: 'FILLED', avgPrice: 30500, executedQty: 0.5 });
            }
            return Promise.resolve({ orderId, status: 'NEW' });
        });
        const pm = new PositionManager({ database: makeDbStub(), broker });
        await openWithLadder(pm);
        await pm._pollTpStatus();

        const after = pm.getOpen('BTCUSDT')[0];
        expect(after.tp1Price).toBeNull(); // C5
        expect(after.exchangeTpActive).toBe(true); // TP2/TP3 still active (M6)
    });

    test('last TP fill drops position from memory and emits positionClosed', async () => {
        const broker = makeBroker();
        const events = [];
        // Ladder → simulate all three as FILLED in one poll. We arrange so that
        // after tp1 fills, status becomes PARTIAL, tp2 and tp3 poll also fire.
        broker.getOrder.mockImplementation(({ orderId }) => {
            const price = orderId === 'tp1-aaa' ? 30500
                        : orderId === 'tp2-bbb' ? 31000
                        : 32000;
            const qty   = orderId === 'tp1-aaa' ? 0.5
                        : orderId === 'tp2-bbb' ? 0.3
                        : 0.2;
            return Promise.resolve({ orderId, status: 'FILLED', avgPrice: price, executedQty: qty });
        });
        const pm = new PositionManager({
            database: makeDbStub(),
            broker,
            onEvent: (evt, payload) => events.push({ evt, payload })
        });
        await openWithLadder(pm);
        await pm._pollTpStatus();

        expect(pm.getOpen('BTCUSDT')).toHaveLength(0);
        const closed = events.find((e) => e.evt === 'positionClosed');
        expect(closed).toBeTruthy();
        expect(closed.payload.reason).toMatch(/TP3:exchange/);
    });
});
