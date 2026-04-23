const { RiskGuard } = require('../../src/services/riskGuard');

describe('Integration: RiskGuard Persistence', () => {
    let mockDb;
    let config;
    let store = {};

    beforeEach(() => {
        store = {};
        mockDb = {
            kvGet: jest.fn((key) => store[key] || null),
            kvSet: jest.fn((key, value) => { store[key] = value; })
        };
        config = {
            maxDailyLossPercent: 3,
            maxConcurrentPositions: 5,
            correlationPenaltyEnabled: false
        };
    });

    test('RiskGuard restores realised PnL and start balance from DB', async () => {
        // Setup initial state in DB
        const today = new Date().toISOString().slice(0, 10);
        store['riskGuard:state'] = {
            dayKey: today,
            realisedPnlUsd: -100,
            startOfDayBalance: 10000
        };

        const rg = new RiskGuard({
            config,
            database: mockDb,
            getAvailableBalanceUsd: () => 9900,
            getOpenPositions: () => []
        });

        await rg.init();

        const snap = rg.snapshot();
        expect(snap.realisedPnlUsd).toBe(-100);
        expect(snap.startOfDayBalance).toBe(10000);
        expect(snap.dailyLossPercent).toBe(1.0); // 100 / 10000 * 100
    });

    test('RiskGuard stays paused after "restart" if limit was hit', async () => {
        const today = new Date().toISOString().slice(0, 10);
        const rg1 = new RiskGuard({
            config,
            database: mockDb,
            getAvailableBalanceUsd: () => 10000,
            getOpenPositions: () => []
        });

        await rg1.init();
        
        // Trigger a pause by recording a large loss
        await rg1.recordRealisedPnl(-400); // 4% loss, limit is 3%
        
        // Evaluate should pause it
        const res = await rg1.evaluate({ symbol: 'BTCUSDT', direction: 'LONG' });
        expect(res.allow).toBe(false);
        expect(rg1.isPaused).toBe(true);
        expect(rg1.snapshot().realisedPnlUsd).toBe(-400);

        // Simulate restart
        const rg2 = new RiskGuard({
            config,
            database: mockDb,
            getAvailableBalanceUsd: () => 9600,
            getOpenPositions: () => []
        });

        await rg2.init();
        
        // Even though it's a new instance, evaluate should find it paused (or pause it again immediately)
        const res2 = await rg2.evaluate({ symbol: 'ETHUSDT', direction: 'LONG' });
        expect(res2.allow).toBe(false);
        expect(rg2.isPaused).toBe(true);
        expect(res2.reason).toContain('daily loss');
    });

    test('RiskGuard rollovers on new day', async () => {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        store['riskGuard:state'] = {
            dayKey: yesterday,
            realisedPnlUsd: -500,
            startOfDayBalance: 10000
        };

        const rg = new RiskGuard({
            config,
            database: mockDb,
            getAvailableBalanceUsd: () => 9500,
            getOpenPositions: () => []
        });

        await rg.init();
        
        // At init, it sees yesterday's state. 
        // But recordRealisedPnl or evaluate triggers rollover.
        await rg.evaluate({ symbol: 'BTCUSDT', direction: 'LONG' });
        
        const snap = rg.snapshot();
        expect(snap.dayKey).toBe(new Date().toISOString().slice(0, 10));
        expect(snap.realisedPnlUsd).toBe(0);
        expect(snap.startOfDayBalance).toBe(9500);
    });
});
