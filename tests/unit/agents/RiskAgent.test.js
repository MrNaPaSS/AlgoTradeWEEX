const { RiskAgent } = require('../../../src/agents/RiskAgent');

// ── Minimal RiskGuard mock ────────────────────────────────────────────────────
function makeGuard({ allow = true, reason = '', warnings = [] } = {}) {
    return {
        evaluate: () => ({ allow, reason, warnings })
    };
}

function makeConfig({
    maxPositionSizePercent = 5,
    defaultLeverage = 5,
    slAtrMult = 1.5,
    tp1AtrMult = 2,
    tp2AtrMult = 3,
    tp3AtrMult = 4
} = {}) {
    return { maxPositionSizePercent, defaultLeverage, slAtrMult, tp1AtrMult, tp2AtrMult, tp3AtrMult };
}

function buildSnapshot({ atr = 50, close = 30000, signalType = 'CE_BUY', symbol = 'BTCUSDT' } = {}) {
    return {
        symbol,
        tf: '1h',
        candles: [],
        indicators: { atr, close },
        triggeringSignal: { signalType }
    };
}

function makeAgent({ guardOpts = {}, configOpts = {}, balance = 10000 } = {}) {
    return new RiskAgent({
        riskGuard: makeGuard(guardOpts),
        riskConfig: makeConfig(configOpts),
        getAvailableBalanceUsd: () => balance
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('RiskAgent', () => {
    test('agent name is RiskAgent', () => {
        expect(makeAgent().name).toBe('RiskAgent');
    });

    test('returns non-veto vote when guard allows and sizing computes', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot());
        expect(vote.veto).toBe(false);
        expect(vote.direction).toBe('LONG');
    });

    test('vote contains sizing metrics when allowed', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot());
        expect(vote.metrics).toBeDefined();
        expect(vote.metrics.sizing).toBeDefined();
        expect(typeof vote.metrics.sizing.quantity).toBe('number');
        expect(typeof vote.metrics.sizing.notionalUsd).toBe('number');
        expect(vote.metrics.sizing.takeProfits).toHaveLength(3);
    });

    test('vetos when guard rejects (daily loss exceeded)', async () => {
        const agent = makeAgent({ guardOpts: { allow: false, reason: 'daily loss limit' } });
        const vote = await agent.analyze(buildSnapshot());
        expect(vote.veto).toBe(true);
        expect(vote.direction).toBe('NEUTRAL');
        expect(vote.reasoning).toContain('daily loss limit');
    });

    test('vetos when ATR is 0 (cannot compute sizing)', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot({ atr: 0 }));
        expect(vote.veto).toBe(true);
    });

    test('CE_BUY signal maps to LONG direction', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot({ signalType: 'CE_BUY' }));
        expect(vote.direction).toBe('LONG');
    });

    test('CE_SELL signal maps to SHORT direction', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot({ signalType: 'CE_SELL' }));
        expect(vote.direction).toBe('SHORT');
    });

    test('stopLoss is below entry for LONG', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot({ signalType: 'CE_BUY', close: 30000, atr: 100 }));
        expect(vote.metrics.sizing.stopLoss).toBeLessThan(30000);
    });

    test('stopLoss is above entry for SHORT', async () => {
        const agent = makeAgent();
        const vote = await agent.analyze(buildSnapshot({ signalType: 'CE_SELL', close: 30000, atr: 100 }));
        expect(vote.metrics.sizing.stopLoss).toBeGreaterThan(30000);
    });
});
