const { TradingOrchestrator } = require('../../../src/services/tradingOrchestrator');

// We only need to test the _computeAdaptiveThreshold method,
// so we create a minimal orchestrator with stubs for required deps.
function createOrchestrator() {
    return new TradingOrchestrator({
        dataAggregator: {},
        indicatorEngine: {},
        tradingAgents: [],
        riskAgent: {},
        arbiter: {},
        positionManager: { getOpen: () => [], syncWithExchange: null },
        database: {},
        riskGuard: {},
        weexClient: {},
        config: {}
    });
}

describe('TradingOrchestrator._computeAdaptiveThreshold', () => {
    let orch;
    beforeEach(() => { orch = createOrchestrator(); });

    // ── Fallback to default (3) ──────────────────────────────────────────
    test('undefined indicators → 3', () => {
        expect(orch._computeAdaptiveThreshold(undefined)).toBe(3);
    });

    test('missing atr → 3', () => {
        expect(orch._computeAdaptiveThreshold({ close: 100 })).toBe(3);
    });

    test('missing close → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 1.5 })).toBe(3);
    });

    test('close = 0 → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 1.5, close: 0 })).toBe(3);
    });

    test('close < 0 → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 1.5, close: -100 })).toBe(3);
    });

    test('atr = NaN → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: NaN, close: 100 })).toBe(3);
    });

    test('atr = Infinity → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: Infinity, close: 100 })).toBe(3);
    });

    // ── Calm market (ATR% < 0.5) → threshold 2 ──────────────────────────
    test('ATR% = 0.3% → 2 (calm market)', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 300, close: 100000 })).toBe(2);
    });

    test('ATR% = 0.49% → 2', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 49, close: 10000 })).toBe(2);
    });

    // ── Normal market (0.5% ≤ ATR% < 1.5%) → threshold 3 ────────────────
    test('ATR% = 0.5% → 3 (normal)', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 50, close: 10000 })).toBe(3);
    });

    test('ATR% = 1.0% → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 1000, close: 100000 })).toBe(3);
    });

    test('ATR% = 1.49% → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 149, close: 10000 })).toBe(3);
    });

    // ── Volatile market (1.5% ≤ ATR% < 3.0%) → threshold 4 ─────────────
    test('ATR% = 1.5% → 4 (volatile)', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 1500, close: 100000 })).toBe(4);
    });

    test('ATR% = 2.5% → 4', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 2500, close: 100000 })).toBe(4);
    });

    test('ATR% = 2.99% → 4', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 299, close: 10000 })).toBe(4);
    });

    // ── Extreme volatility (ATR% ≥ 3.0%) → threshold 5 ──────────────────
    test('ATR% = 3.0% → 5 (extreme)', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 3000, close: 100000 })).toBe(5);
    });

    test('ATR% = 5.0% → 5', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 5000, close: 100000 })).toBe(5);
    });

    test('ATR% = 10.0% → 5', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 10000, close: 100000 })).toBe(5);
    });

    // ── Real-world scenarios ─────────────────────────────────────────────
    test('BTC calm: price=100000, ATR=300 → 2', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 300, close: 100000 })).toBe(2);
    });

    test('ETH normal: price=3500, ATR=40 → 3', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 40, close: 3500 })).toBe(3);
    });

    test('SOL volatile: price=150, ATR=3.5 → 4', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 3.5, close: 150 })).toBe(4);
    });

    test('XAUT gold (very calm): price=2400, ATR=5 → 2', () => {
        expect(orch._computeAdaptiveThreshold({ atr: 5, close: 2400 })).toBe(2);
    });
});
