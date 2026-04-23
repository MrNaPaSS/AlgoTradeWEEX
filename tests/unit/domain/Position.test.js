const { createPosition, updatePosition, computeUnrealizedPnl } = require('../../../src/domain/Position');

describe('Position domain', () => {
    const base = {
        symbol: 'BTCUSDT',
        side: 'long',
        entryPrice: 50000,
        totalQuantity: 0.1,
        leverage: 5
    };

    test('createPosition produces immutable record with defaults', () => {
        const p = createPosition(base);
        expect(p.positionId).toBeDefined();
        expect(p.status).toBe('OPEN');
        expect(p.remainingQuantity).toBe(base.totalQuantity);
        expect(p.realizedPnl).toBe(0);
        expect(Object.isFrozen(p)).toBe(true);
    });

    test('createPosition rejects invalid side', () => {
        expect(() => createPosition({ ...base, side: 'BUY' })).toThrow(/side/);
    });

    test('updatePosition returns a NEW frozen object and does not mutate the original', () => {
        const p1 = createPosition(base);
        const p2 = updatePosition(p1, { status: 'PARTIAL', remainingQuantity: 0.05 });
        expect(p2).not.toBe(p1);
        expect(p1.status).toBe('OPEN');
        expect(p2.status).toBe('PARTIAL');
        expect(p2.remainingQuantity).toBe(0.05);
        expect(p2.positionId).toBe(p1.positionId);
    });

    test('computeUnrealizedPnl: long profit', () => {
        const p = createPosition(base);
        expect(computeUnrealizedPnl(p, 51000)).toBeCloseTo(100, 5);
    });

    test('computeUnrealizedPnl: short profit', () => {
        const p = createPosition({ ...base, side: 'short' });
        expect(computeUnrealizedPnl(p, 49000)).toBeCloseTo(100, 5);
    });

    test('computeUnrealizedPnl: long loss is negative', () => {
        const p = createPosition(base);
        expect(computeUnrealizedPnl(p, 49000)).toBeLessThan(0);
    });
});
