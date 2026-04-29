'use strict';

/**
 * Integration tests: UserTradeEngine multi-user concurrency
 *
 * Mock strategy:
 * - jest.mock() all external module dependencies (_bootUser touches)
 * - For fanOutDecision / onMarkPrice tests (1-5): inject fake engines directly
 *   into instance._engines to bypass _bootUser entirely.
 * - For lifecycle / updateUserRisk tests (6-7): spy on _bootUser and inject
 *   fake engines from within the mock implementation.
 */

// ─── Module mocks (must be hoisted before any require) ────────────────────────

jest.mock('../../src/utils/crypto', () => ({
    encrypt: jest.fn((v) => `enc:${v}`),
    decrypt: jest.fn((v) => (v ? v.replace('enc:', '') : 'decrypted'))
}));

jest.mock('../../src/api/weex/WeexFuturesClient', () => ({
    WeexFuturesClient: jest.fn().mockImplementation(() => ({
        getPositions: jest.fn().mockResolvedValue([]),
        setLeverage: jest.fn().mockResolvedValue(undefined)
    }))
}));

jest.mock('../../src/services/LiveBroker', () => ({
    LiveBroker: jest.fn().mockImplementation(() => ({
        getAvailableBalanceUsd: jest.fn().mockResolvedValue(10000),
        _lastBalance: 10000
    }))
}));

jest.mock('../../src/services/riskGuard', () => ({
    RiskGuard: jest.fn().mockImplementation(({ config } = {}) => ({
        _config: config || {},
        init: jest.fn().mockResolvedValue(undefined),
        evaluate: jest.fn().mockResolvedValue({ allow: true, sizingMultiplier: 1 }),
        isPaused: false
    }))
}));

jest.mock('../../src/services/positionManager', () => ({
    PositionManager: jest.fn().mockImplementation(() => ({
        syncWithExchange: jest.fn().mockResolvedValue(undefined),
        startTpPolling: jest.fn(),
        stopTpPolling: jest.fn(),
        onMarkPrice: jest.fn().mockResolvedValue(undefined),
        open: jest.fn().mockResolvedValue({ positionId: 'pos-1', symbol: 'BTCUSDT' }),
        getOpen: jest.fn().mockReturnValue([]),
        _riskGuard: null
    }))
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const { UserTradeEngine } = require('../../src/services/userTradeEngine');
const { RiskGuard } = require('../../src/services/riskGuard');

/**
 * Build a minimal UserTradeEngine instance with stub deps.
 * Does NOT call loadAllUsers — engines are injected manually.
 */
function makeEngine() {
    return new UserTradeEngine({
        database: {
            getActiveUsers: jest.fn().mockResolvedValue([]),
            updateUser: jest.fn().mockResolvedValue(undefined),
            insertRiskEvent: jest.fn().mockResolvedValue(undefined)
        },
        telegram: {
            notifyPositionOpened: jest.fn().mockResolvedValue(undefined),
            notifyPositionClosed: jest.fn().mockResolvedValue(undefined),
            sendMessage: jest.fn().mockResolvedValue(undefined)
        },
        config: {
            risk: {
                exchangeMinNotionalUsd: 5,
                slAtrMult: 3.0,
                tp1AtrMult: 2.0,
                tp2AtrMult: 3.0,
                tp3AtrMult: 6.0
            }
        },
        metrics: {}
    });
}

/**
 * Create a fake per-user engine entry (what _bootUser stores in _engines).
 */
function makeFakeUserEngine({
    userId = 'user-A',
    symbols = [],
    riskGuardOverride = null,
    positionManagerOverride = null
} = {}) {
    const riskGuard = riskGuardOverride || {
        evaluate: jest.fn().mockResolvedValue({ allow: true, sizingMultiplier: 1 }),
        _config: { maxPositionSizePercent: 5, defaultLeverage: 5 }
    };

    const positionManager = positionManagerOverride || {
        open: jest.fn().mockResolvedValue({ positionId: `pos-${userId}`, symbol: 'BTCUSDT' }),
        onMarkPrice: jest.fn().mockResolvedValue(undefined),
        stopTpPolling: jest.fn(),
        _riskGuard: null
    };

    const broker = {
        getAvailableBalanceUsd: jest.fn().mockResolvedValue(10000),
        _lastBalance: 10000
    };

    return { userId, symbols, riskGuard, positionManager, broker, chatId: 100 };
}

/**
 * Build a snapshot that passes _computeUserSizing validation.
 */
const VALID_SNAPSHOT = {
    indicators: { close: 30000, atr: 150 }
};

/**
 * Build a minimal EXECUTE decision.
 */
function makeDecision(overrides = {}) {
    return {
        id: 'dec-1',
        outcome: 'EXECUTE',
        direction: 'LONG',
        symbol: 'BTCUSDT',
        ...overrides
    };
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('UserTradeEngine — fanOutDecision', () => {

    // ── Test 1: parallel isolation — one user fails, others succeed ────────────

    test('1. parallel isolation: user B throws, users A and C still succeed', async () => {
        const ute = makeEngine();

        const pmA = { open: jest.fn().mockResolvedValue({ positionId: 'pos-A' }), stopTpPolling: jest.fn(), _riskGuard: null };
        const pmB = { open: jest.fn().mockRejectedValue(new Error('exchange timeout')), stopTpPolling: jest.fn(), _riskGuard: null };
        const pmC = { open: jest.fn().mockResolvedValue({ positionId: 'pos-C' }), stopTpPolling: jest.fn(), _riskGuard: null };

        const engA = makeFakeUserEngine({ userId: 'user-A', positionManagerOverride: pmA });
        const engB = makeFakeUserEngine({ userId: 'user-B', positionManagerOverride: pmB });
        const engC = makeFakeUserEngine({ userId: 'user-C', positionManagerOverride: pmC });

        ute._engines.set('user-A', engA);
        ute._engines.set('user-B', engB);
        ute._engines.set('user-C', engC);

        const results = await ute.fanOutDecision(makeDecision(), VALID_SNAPSHOT);

        expect(results).toHaveLength(3);

        const rA = results.find(r => r.userId === 'user-A');
        const rB = results.find(r => r.userId === 'user-B');
        const rC = results.find(r => r.userId === 'user-C');

        expect(rA).toMatchObject({ success: true });
        expect(rB).toMatchObject({ success: false });
        expect(rC).toMatchObject({ success: true });

        // A and C's open() must have been invoked despite B throwing
        expect(pmA.open).toHaveBeenCalledTimes(1);
        expect(pmC.open).toHaveBeenCalledTimes(1);
    });

    // ── Test 2: symbol filtering ───────────────────────────────────────────────

    test('2. symbol filtering: only the user with matching symbol gets open() called', async () => {
        const ute = makeEngine();

        const pmA = { open: jest.fn().mockResolvedValue({ positionId: 'pos-A' }), stopTpPolling: jest.fn(), _riskGuard: null };
        const pmB = { open: jest.fn().mockResolvedValue({ positionId: 'pos-B' }), stopTpPolling: jest.fn(), _riskGuard: null };

        const engA = makeFakeUserEngine({ userId: 'user-A', symbols: ['BTCUSDT'], positionManagerOverride: pmA });
        const engB = makeFakeUserEngine({ userId: 'user-B', symbols: ['ETHUSDT'], positionManagerOverride: pmB });

        ute._engines.set('user-A', engA);
        ute._engines.set('user-B', engB);

        // Decision is for BTCUSDT
        const results = await ute.fanOutDecision(makeDecision({ symbol: 'BTCUSDT' }), VALID_SNAPSHOT);

        expect(results).toHaveLength(2);

        const rA = results.find(r => r.userId === 'user-A');
        const rB = results.find(r => r.userId === 'user-B');

        // User A should have succeeded
        expect(rA).toMatchObject({ success: true });
        expect(pmA.open).toHaveBeenCalledTimes(1);

        // User B filtered out — open never called
        expect(pmB.open).not.toHaveBeenCalled();
        expect(rB).toMatchObject({ success: false, reason: 'symbol_not_enabled' });
    });

    // ── Test 3: risk block ─────────────────────────────────────────────────────

    test('3. risk block: user blocked by riskGuard, open() never called', async () => {
        const ute = makeEngine();

        const blockedRiskGuard = {
            evaluate: jest.fn().mockResolvedValue({ allow: false, reason: 'daily_loss_limit' }),
            _config: { maxPositionSizePercent: 5, defaultLeverage: 5 }
        };
        const pm = { open: jest.fn().mockResolvedValue({ positionId: 'pos-A' }), stopTpPolling: jest.fn(), _riskGuard: null };

        const eng = makeFakeUserEngine({
            userId: 'user-A',
            riskGuardOverride: blockedRiskGuard,
            positionManagerOverride: pm
        });
        ute._engines.set('user-A', eng);

        const results = await ute.fanOutDecision(makeDecision(), VALID_SNAPSHOT);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ userId: 'user-A', success: false, reason: 'daily_loss_limit' });
        expect(pm.open).not.toHaveBeenCalled();
    });

    // ── Test 4: NEUTRAL direction is skipped ───────────────────────────────────

    test('4. NEUTRAL direction returns empty array without calling open()', async () => {
        const ute = makeEngine();

        const pm = { open: jest.fn().mockResolvedValue({ positionId: 'pos-X' }), stopTpPolling: jest.fn(), _riskGuard: null };
        const eng = makeFakeUserEngine({ userId: 'user-A', positionManagerOverride: pm });
        ute._engines.set('user-A', eng);

        const results = await ute.fanOutDecision(
            makeDecision({ direction: 'NEUTRAL' }),
            VALID_SNAPSHOT
        );

        expect(results).toEqual([]);
        expect(pm.open).not.toHaveBeenCalled();
    });

});

// ─────────────────────────────────────────────────────────────────────────────

describe('UserTradeEngine — onMarkPrice', () => {

    // ── Test 5: parallel fanout — one throws, other still called ──────────────

    test('5. onMarkPrice parallel fanout: user A throws, user B still receives tick', async () => {
        const ute = makeEngine();

        const pmA = {
            onMarkPrice: jest.fn().mockRejectedValue(new Error('SL check failed')),
            stopTpPolling: jest.fn(),
            _riskGuard: null
        };
        const pmB = {
            onMarkPrice: jest.fn().mockResolvedValue(undefined),
            stopTpPolling: jest.fn(),
            _riskGuard: null
        };

        const engA = makeFakeUserEngine({ userId: 'user-A', positionManagerOverride: pmA });
        const engB = makeFakeUserEngine({ userId: 'user-B', positionManagerOverride: pmB });

        ute._engines.set('user-A', engA);
        ute._engines.set('user-B', engB);

        // Must resolve — not throw — even though user A rejects
        await expect(ute.onMarkPrice('BTCUSDT', 30000)).resolves.toBeUndefined();

        expect(pmA.onMarkPrice).toHaveBeenCalledWith('BTCUSDT', 30000);
        expect(pmB.onMarkPrice).toHaveBeenCalledWith('BTCUSDT', 30000);
    });

});

// ─────────────────────────────────────────────────────────────────────────────

describe('UserTradeEngine — addUser / removeUser lifecycle', () => {

    // ── Test 6: lifecycle: add → exists, remove → null, re-add → rebuilt ──────

    test('6. lifecycle: addUser stores engine, removeUser deletes it, re-add rebuilds', async () => {
        const ute = makeEngine();
        const userId = 'user-lifecycle';

        // Spy on _bootUser so we don't touch real modules
        let callCount = 0;
        jest.spyOn(ute, '_bootUser').mockImplementation(async (row) => {
            callCount += 1;
            const fakeEng = makeFakeUserEngine({ userId: row.user_id });
            ute._engines.set(row.user_id, fakeEng);
        });

        const userRow = {
            user_id: userId,
            encrypted_api_key: 'enc:key',
            encrypted_secret: 'enc:secret',
            encrypted_passphrase: 'enc:pass',
            telegram_chat_id: 42,
            symbols: '',
            risk_paused: 0,
            risk_pause_reason: null
        };

        // Initially no engine
        expect(ute.getEngine(userId)).toBeNull();

        // addUser → engine should exist
        await ute.addUser(userRow);
        expect(ute.getEngine(userId)).not.toBeNull();
        expect(callCount).toBe(1);

        // removeUser → engine gone
        await ute.removeUser(userId);
        expect(ute.getEngine(userId)).toBeNull();

        // addUser again (same userId) → engine rebuilt (new _bootUser call)
        await ute.addUser(userRow);
        expect(ute.getEngine(userId)).not.toBeNull();
        expect(callCount).toBe(2);
    });

    test('6b. addUser with already-running userId tears down old engine first', async () => {
        const ute = makeEngine();
        const userId = 'user-dup';

        let bootCallCount = 0;
        jest.spyOn(ute, '_bootUser').mockImplementation(async (row) => {
            bootCallCount += 1;
            ute._engines.set(row.user_id, makeFakeUserEngine({ userId: row.user_id }));
        });

        const userRow = { user_id: userId, symbols: '', risk_paused: 0 };

        await ute.addUser(userRow);
        expect(bootCallCount).toBe(1);

        // Add same user again — should remove old then boot again
        await ute.addUser(userRow);
        expect(bootCallCount).toBe(2);

        // Only one engine should be registered (not two)
        expect(ute.getAllActiveUserIds()).toEqual([userId]);
    });

});

// ─────────────────────────────────────────────────────────────────────────────

describe('UserTradeEngine — updateUserRisk', () => {

    // ── Test 7: RiskGuard replaced with new instance ──────────────────────────

    test('7. updateUserRisk replaces riskGuard and injects into positionManager', async () => {
        const ute = makeEngine();
        const userId = 'user-risk';

        // Old RiskGuard stub
        const oldRiskGuard = {
            evaluate: jest.fn().mockResolvedValue({ allow: true }),
            _config: { maxDailyLossPercent: 1, maxPositionSizePercent: 5, defaultLeverage: 5 }
        };

        const pm = {
            open: jest.fn().mockResolvedValue({ positionId: 'pos-risk' }),
            onMarkPrice: jest.fn().mockResolvedValue(undefined),
            stopTpPolling: jest.fn(),
            getOpen: jest.fn().mockReturnValue([]),
            _riskGuard: oldRiskGuard
        };

        const broker = {
            getAvailableBalanceUsd: jest.fn().mockResolvedValue(10000),
            _lastBalance: 10000
        };

        ute._engines.set(userId, {
            userId,
            symbols: [],
            chatId: 100,
            broker,
            riskGuard: oldRiskGuard,
            positionManager: pm
        });

        // New risk settings
        const newSettings = {
            risk_max_daily_loss_pct: 5,
            risk_max_positions: 5,
            risk_leverage: 10,
            risk_position_size_pct: 8,
            risk_paused: 0,
            risk_pause_reason: null
        };

        // RiskGuard constructor (mocked at top) returns a fresh object each call
        await ute.updateUserRisk(userId, newSettings);

        const updatedEngine = ute.getEngine(userId);
        expect(updatedEngine).not.toBeNull();

        // riskGuard on the engine should be the newly constructed instance
        expect(updatedEngine.riskGuard).not.toBe(oldRiskGuard);

        // positionManager._riskGuard should also point to the new instance
        expect(updatedEngine.positionManager._riskGuard).toBe(updatedEngine.riskGuard);

        // Confirm RiskGuard was constructed with the new maxDailyLossPercent
        const lastCall = RiskGuard.mock.calls[RiskGuard.mock.calls.length - 1][0];
        expect(lastCall.config.maxDailyLossPercent).toBe(5);
    });

    test('7b. updateUserRisk on non-existent user does not throw', async () => {
        const ute = makeEngine();
        await expect(ute.updateUserRisk('ghost-user', { risk_max_daily_loss_pct: 5 }))
            .resolves.toBeUndefined();
    });

});
