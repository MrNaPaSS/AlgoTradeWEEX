/**
 * Regression tests — SL moves to exchange breakeven after EVERY TP level,
 * not just TP1.
 *
 * Fix: _partialClose (numeric orderId path) now runs the breakeven SL move
 * for ALL TP levels whenever updated.status !== 'CLOSED'.  Previously only
 * level === 1 triggered the move.
 *
 * Scenarios:
 *   1. After TP2 fills (TP3 still remaining), modifySlTp is called with the
 *      exchange breakEvenPrice.
 *   2. After TP3 fills (position fully closed), modifySlTp is NOT called.
 *   3. isImprovement guard: if new breakeven is WORSE than current SL
 *      (lower for LONG), SL is NOT moved.
 *   4. Fallback: if getOpenPositions doesn't return breakEvenPrice, the
 *      local formula is used and modifySlTp is still called.
 *
 * Strategy: use the numeric orderId path (_partialClose) triggered via
 * onMarkPrice + _evaluateExits. Positions are created with NO tpNOrderId so
 * the local branch is exercised (no deferral to exchange). Broker is in live
 * mode so the breakeven logic fires.
 */

const { PositionManager } = require('../../../src/services/PositionManager');

jest.mock('../../../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDbStub() {
    return {
        getOpenPositions: jest.fn(() => []),
        insertPosition:   jest.fn(),
        updatePosition:   jest.fn(),
        insertPartialClose: jest.fn(),
        insertRiskEvent:  jest.fn()
    };
}

/**
 * Build a live broker stub.
 * @param {object} opts
 * @param {number|null} opts.exchangeBreakEven  - returned by getOpenPositions; null to omit
 * @param {object}      opts.overrides          - additional mock overrides
 */
function makeLiveBroker({ exchangeBreakEven = 2010, overrides = {} } = {}) {
    const broker = {
        mode: 'live',
        _takerFeeRate: 0.0004,

        placeMarketOrder: jest.fn().mockResolvedValue({
            orderId: 'entry-1',
            slOrderId: 'sl-xyz',
            price: 2000
        }),

        placeTpLadder: jest.fn().mockResolvedValue({
            // NO tp order ids — forces numeric/local path in _evaluateExits
            tp1OrderId: null, tp2OrderId: null, tp3OrderId: null
        }),

        closeMarket: jest.fn().mockResolvedValue({
            orderId: 'close-1', pnl: 50, price: 2100
        }),

        cancelOrderById: jest.fn().mockResolvedValue(null),
        cancelAllForSymbol: jest.fn().mockResolvedValue({ cancelled: [], skipped: [] }),

        getOpenPositions: jest.fn().mockResolvedValue(
            exchangeBreakEven != null
                ? [{ symbol: 'ETHUSDT', side: 'long', breakEvenPrice: exchangeBreakEven, remainingQuantity: 0.5 }]
                : [{ symbol: 'ETHUSDT', side: 'long', breakEvenPrice: null, remainingQuantity: 0.5 }]
        ),

        modifySlTp: jest.fn().mockResolvedValue({ success: true, mode: 'modify' }),

        ...overrides
    };
    return broker;
}

/**
 * Open an ETHUSDT LONG with TP1=2050, TP2=2100, TP3=2200, SL=1900.
 * All three TP order ids are null (no exchange TP ladder) so local
 * evaluation fires when mark price is pushed above each level.
 */
async function openPosition(pm) {
    return pm.open({
        symbol: 'ETHUSDT',
        direction: 'LONG',
        markPrice: 2000,
        sizing: {
            quantity: 1.0,
            leverage: 5,
            stopLoss: 1900,
            entryPrice: 2000,
            takeProfits: [
                { price: 2050, closePercent: 50 },
                { price: 2100, closePercent: 30 },
                { price: 2200, closePercent: 20 }
            ]
        },
        decisionId: 'dec-be-test'
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PositionManager — SL moves to breakeven after every TP (numeric path)', () => {

    /**
     * 1. After TP2 fills (position still PARTIAL with TP3 remaining),
     *    modifySlTp is called with the exchange breakEvenPrice.
     *
     *    To keep the isImprovement guard satisfied:
     *    - TP1 exchange breakeven = 2010 (stopLoss moves from 1900 → 2010)
     *    - TP2 exchange breakeven = 2030 (strictly better than 2010 → fires)
     */
    test('TP2 fill triggers SL move with exchange breakEvenPrice', async () => {
        const broker = makeLiveBroker({ exchangeBreakEven: 2010 });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openPosition(pm);

        // Trigger TP1 fill (mark price crosses 2050).
        // Exchange breakeven = 2010, which is better than initial SL 1900, so move fires.
        await pm.onMarkPrice('ETHUSDT', 2055);

        // Reset mock between TP levels so we can assert TP2 independently.
        broker.modifySlTp.mockClear();
        broker.closeMarket.mockClear();

        // For TP2: exchange has recalculated a HIGHER breakeven (cost basis improved
        // after the TP1 partial close reduced position size). Must be > 2010 (the SL
        // value set by TP1) so isImprovement passes.
        broker.getOpenPositions.mockResolvedValue([
            { symbol: 'ETHUSDT', side: 'long', breakEvenPrice: 2030, remainingQuantity: 0.5 }
        ]);

        // Trigger TP2 fill (mark price crosses 2100).
        // Position is PARTIAL; remainingQty (0.5) > totalQty * 0.21 (0.21) → gate passes.
        await pm.onMarkPrice('ETHUSDT', 2105);

        // modifySlTp should be called with the updated exchange breakeven from getOpenPositions.
        expect(broker.modifySlTp).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'ETHUSDT',
                slTriggerPrice: 2030
            })
        );
    });

    /**
     * 2. After TP3 fills (position is fully CLOSED), modifySlTp is NOT called.
     */
    test('TP3 fill (full close) does NOT call modifySlTp', async () => {
        const broker = makeLiveBroker({ exchangeBreakEven: 2010 });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openPosition(pm);

        // Drive through TP1 and TP2 so the position becomes PARTIAL with only TP3 left.
        await pm.onMarkPrice('ETHUSDT', 2055); // TP1 hit
        await pm.onMarkPrice('ETHUSDT', 2105); // TP2 hit

        broker.modifySlTp.mockClear();

        // TP3: _closeFull is called instead of _partialClose, so position is CLOSED.
        // Expect modifySlTp NOT to be called for this final fill.
        await pm.onMarkPrice('ETHUSDT', 2205); // TP3 hit

        expect(broker.modifySlTp).not.toHaveBeenCalled();
    });

    /**
     * 3. isImprovement guard: if the exchange breakeven is LOWER than the
     *    current SL for a LONG position (i.e. it would move SL backward),
     *    modifySlTp must NOT be called.
     */
    test('SL is NOT moved when new breakeven is worse than current SL (isImprovement guard)', async () => {
        // After TP1 the SL was already moved to 2010 (persisted in memory).
        // Simulate a second TP fill where breakeven regresses to 1950 (below
        // the current SL) — the guard must block the call.
        const broker = makeLiveBroker({ exchangeBreakEven: 1950 });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openPosition(pm);

        // TP1 fires. With exchangeBreakEven=1950 (below current SL of 1900 set
        // at open), it actually IS an improvement initially (1950 > 1900), so
        // modifySlTp will fire for TP1.
        await pm.onMarkPrice('ETHUSDT', 2055);

        // For TP2: simulate that the SL has already been moved to 2010 in memory
        // (beyond what exchange reports as 1950). We need a breakeven that is
        // STRICTLY WORSE than 2010.  Use a fresh PM so we can control stopLoss.
        const broker2 = makeLiveBroker({ exchangeBreakEven: 1980 });
        // Preset stopLoss to 2010 to simulate already-moved SL.
        broker2.placeMarketOrder.mockResolvedValue({ orderId: 'entry-2', slOrderId: 'sl-2', price: 2000 });
        const pm2 = new PositionManager({ database: makeDbStub(), broker: broker2 });

        await pm2.open({
            symbol: 'ETHUSDT',
            direction: 'LONG',
            markPrice: 2000,
            sizing: {
                quantity: 1.0,
                leverage: 5,
                stopLoss: 2010, // already-moved SL — new BE of 1980 is worse
                entryPrice: 2000,
                takeProfits: [
                    { price: 2050, closePercent: 50 },
                    { price: 2100, closePercent: 30 },
                    { price: 2200, closePercent: 20 }
                ]
            },
            decisionId: 'dec-guard'
        });

        // Trigger TP1. exchangeBreakEven=1980 < currentSL=2010 → NOT an improvement.
        broker2.modifySlTp.mockClear();
        await pm2.onMarkPrice('ETHUSDT', 2055);

        expect(broker2.modifySlTp).not.toHaveBeenCalled();
    });

    /**
     * 4. If getOpenPositions does not return a breakEvenPrice, the local
     *    formula is used as fallback and modifySlTp is still called.
     */
    test('falls back to local formula when exchange breakEvenPrice is absent', async () => {
        const broker = makeLiveBroker({ exchangeBreakEven: null });
        // Ensure getOpenPositions returns a position without a usable breakEvenPrice.
        broker.getOpenPositions.mockResolvedValue([
            { symbol: 'ETHUSDT', side: 'long', breakEvenPrice: null, remainingQuantity: 0.5 }
        ]);

        const pm = new PositionManager({ database: makeDbStub(), broker });
        await openPosition(pm);

        broker.modifySlTp.mockClear();
        await pm.onMarkPrice('ETHUSDT', 2055); // TP1 fill

        // Local formula gives breakeven slightly above entryPrice (2000) to
        // cover fees. The guard (isImprovement: beSl > currentSL=1900) passes.
        expect(broker.modifySlTp).toHaveBeenCalledTimes(1);
        const callArg = broker.modifySlTp.mock.calls[0][0];
        // Local formula result is strictly above 1900 and below the TP fill
        // price (2050) so it passes validation.
        expect(callArg.slTriggerPrice).toBeGreaterThan(1900);
        expect(callArg.slTriggerPrice).toBeLessThan(2050);
    });

    /**
     * 5. After TP2 fills, modifySlTp passes the tracked slOrderId from the
     *    position, ensuring WEEX routes the modify to the correct plan order.
     *    Exchange breakeven for TP2 (2030) must be strictly higher than the SL
     *    value set during TP1 (2010) so the isImprovement guard passes.
     */
    test('modifySlTp is called with the tracked slOrderId from position', async () => {
        const broker = makeLiveBroker({ exchangeBreakEven: 2010 });
        const pm = new PositionManager({ database: makeDbStub(), broker });

        await openPosition(pm);

        // TP1: exchange breakeven = 2010 > currentSL 1900 → SL moves to 2010.
        await pm.onMarkPrice('ETHUSDT', 2055);

        broker.modifySlTp.mockClear();
        // TP2: exchange breakeven = 2030 > current SL 2010 → isImprovement passes.
        broker.getOpenPositions.mockResolvedValue([
            { symbol: 'ETHUSDT', side: 'long', breakEvenPrice: 2030, remainingQuantity: 0.5 }
        ]);

        await pm.onMarkPrice('ETHUSDT', 2105); // TP2

        expect(broker.modifySlTp).toHaveBeenCalledWith(
            expect.objectContaining({
                symbol: 'ETHUSDT',
                orderId: 'sl-xyz'
            })
        );
    });
});
