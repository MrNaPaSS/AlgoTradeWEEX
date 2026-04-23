const { RiskGuard } = require('../../../src/services/riskGuard');

function mkGuard(positions = []) {
    const stubDb = {
        insertRiskEvent: () => {},
        getKv: () => null,
        setKv: () => {}
    };
    const guard = new RiskGuard({
        database: stubDb,
        config: {
            maxDailyLossPercent: 10,
            maxConcurrentPositions: 10,
            correlationVetoThreshold: 0.75,
            correlationPenaltyEnabled: true
        },
        getAvailableBalanceUsd: async () => 10000,
        getOpenPositions: () => positions
    });
    return guard;
}

describe('RiskGuard correlation sizing penalty (Variant B)', () => {
    test('no cluster exposure → full size (multiplier 1)', async () => {
        const guard = mkGuard([]);
        const res = await guard.evaluate({ symbol: 'BTCUSDT', direction: 'LONG' });
        expect(res.allow).toBe(true);
        expect(res.sizingMultiplier).toBe(1);
        expect(res.correlation.correlatedCount).toBe(0);
    });

    test('one same-direction cluster position → 50% size', async () => {
        const guard = mkGuard([{ symbol: 'BTCUSDT', side: 'long' }]);
        const res = await guard.evaluate({ symbol: 'ETHUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(0.5);
        expect(res.correlation.correlatedCount).toBe(1);
        expect(res.warnings.some((w) => /correlated/i.test(w))).toBe(true);
    });

    test('two cluster positions → 25% size', async () => {
        const guard = mkGuard([
            { symbol: 'BTCUSDT', side: 'long' },
            { symbol: 'ETHUSDT', side: 'long' }
        ]);
        const res = await guard.evaluate({ symbol: 'SOLUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(0.25);
    });

    test('three cluster positions → 12.5% (floor)', async () => {
        const guard = mkGuard([
            { symbol: 'BTCUSDT', side: 'long' },
            { symbol: 'ETHUSDT', side: 'long' },
            { symbol: 'SOLUSDT', side: 'long' }
        ]);
        const res = await guard.evaluate({ symbol: 'BNBUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(0.125);
    });

    test('four+ cluster positions still clamped at 12.5%', async () => {
        const guard = mkGuard([
            { symbol: 'BTCUSDT', side: 'long' },
            { symbol: 'ETHUSDT', side: 'long' },
            { symbol: 'SOLUSDT', side: 'long' },
            { symbol: 'BNBUSDT', side: 'long' }
        ]);
        const res = await guard.evaluate({ symbol: 'XRPUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(0.125);
    });

    test('opposite-direction positions do NOT trigger penalty', async () => {
        const guard = mkGuard([{ symbol: 'BTCUSDT', side: 'short' }]);
        const res = await guard.evaluate({ symbol: 'ETHUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(1);
        expect(res.correlation.correlatedCount).toBe(0);
    });

    test('XAUT (gold) is outside the crypto cluster → always full size', async () => {
        const guard = mkGuard([
            { symbol: 'BTCUSDT', side: 'long' },
            { symbol: 'ETHUSDT', side: 'long' }
        ]);
        const res = await guard.evaluate({ symbol: 'XAUTUSDT', direction: 'LONG' });
        expect(res.sizingMultiplier).toBe(1);
    });
});
