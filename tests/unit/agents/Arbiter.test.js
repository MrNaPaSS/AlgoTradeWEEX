const { Arbiter } = require('../../../src/agents/Arbiter');
const { createVote } = require('../../../src/domain/Vote');

// ── Helpers ──────────────────────────────────────────────────────────────────

const mkVote = (agent, direction, confidence, opts = {}) =>
    createVote({ agent, direction, confidence, reasoning: opts.reasoning || 'test', veto: opts.veto, metrics: opts.metrics });

const mkSnapshot = (symbol = 'BTCUSDT') => ({
    symbol, tf: '1h', candles: [], indicators: { close: 100000, atr: 1500 }
});

const mkSignal = () => ({ id: 'sig-1', signalType: 'CE_BUY', price: 100000 });

/** 3 LONG + 1 SHORT + RiskAgent allow */
const standardVotes = () => [
    mkVote('TechnicalAgent', 'LONG', 0.8),
    mkVote('BlackMirrorAgent', 'LONG', 0.7),
    mkVote('ChandelierAgent', 'LONG', 0.6),
    mkVote('SentimentAgent', 'SHORT', 0.4),
    mkVote('RiskAgent', 'NEUTRAL', 0.5, { metrics: { sizing: { qty: 0.01, stopLoss: 99000 } } })
];

/** All NEUTRAL except RiskAgent */
const neutralVotes = () => [
    mkVote('TechnicalAgent', 'NEUTRAL', 0),
    mkVote('BlackMirrorAgent', 'NEUTRAL', 0),
    mkVote('ChandelierAgent', 'NEUTRAL', 0),
    mkVote('SentimentAgent', 'NEUTRAL', 0),
    mkVote('RiskAgent', 'NEUTRAL', 0.5, { metrics: { sizing: { qty: 0.01, stopLoss: 99000 } } })
];

const mockLlm = (response = null) => ({
    isConfigured: true,
    askJson: jest.fn().mockResolvedValue(response)
});

const mockDb = (rows = []) => ({
    getRecentDecisions: jest.fn().mockResolvedValue(rows)
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Arbiter', () => {
    // ── Constructor & mode ───────────────────────────────────────────────

    test('default mode is STANDARD', () => {
        const a = new Arbiter();
        expect(a.mode).toBe('STANDARD');
    });

    test('setMode changes mode', () => {
        const a = new Arbiter({ mode: 'FAST' });
        expect(a.mode).toBe('FAST');
        a.setMode('FULL');
        expect(a.mode).toBe('FULL');
    });

    // ── Risk veto ────────────────────────────────────────────────────────

    test('risk veto → immediate REJECT', async () => {
        const a = new Arbiter({ mode: 'FAST' });
        const votes = [
            mkVote('TechnicalAgent', 'LONG', 0.9),
            mkVote('RiskAgent', 'NEUTRAL', 0, { veto: true, reasoning: 'daily loss exceeded' })
        ];
        const d = await a.decide({ snapshot: mkSnapshot(), votes, triggeringSignal: mkSignal() });
        expect(d.outcome).toBe('REJECT');
        expect(d.direction).toBe('NEUTRAL');
        expect(d.arbiterReasoning).toContain('Вето');
    });

    test('missing RiskAgent vote → REJECT (treated as veto)', async () => {
        const a = new Arbiter({ mode: 'FAST' });
        const votes = [mkVote('TechnicalAgent', 'LONG', 0.9)];
        const d = await a.decide({ snapshot: mkSnapshot(), votes, triggeringSignal: mkSignal() });
        expect(d.outcome).toBe('REJECT');
    });

    // ── Consensus threshold (FAST mode, no LLM) ─────────────────────────

    test('3 LONG at threshold=3 → EXECUTE', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const d = await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });
        expect(d.outcome).toBe('EXECUTE');
        expect(d.direction).toBe('LONG');
    });

    test('2 LONG at threshold=3 → HOLD', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const votes = [
            mkVote('TechnicalAgent', 'LONG', 0.8),
            mkVote('BlackMirrorAgent', 'LONG', 0.7),
            mkVote('ChandelierAgent', 'NEUTRAL', 0),
            mkVote('SentimentAgent', 'SHORT', 0.4),
            mkVote('RiskAgent', 'NEUTRAL', 0.5, { metrics: { sizing: { qty: 0.01 } } })
        ];
        const d = await a.decide({ snapshot: mkSnapshot(), votes, triggeringSignal: mkSignal() });
        expect(d.outcome).toBe('HOLD');
    });

    test('all NEUTRAL → HOLD', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const d = await a.decide({ snapshot: mkSnapshot(), votes: neutralVotes(), triggeringSignal: mkSignal() });
        expect(d.outcome).toBe('HOLD');
        expect(d.direction).toBe('NEUTRAL');
    });

    // ── overrideThreshold ────────────────────────────────────────────────

    test('overrideThreshold overrides consensusThreshold', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 5 });
        // With threshold=5, 3 LONG would be HOLD; but override to 2 → EXECUTE
        const d = await a.decide({
            snapshot: mkSnapshot(), votes: standardVotes(),
            triggeringSignal: mkSignal(), overrideThreshold: 2
        });
        expect(d.outcome).toBe('EXECUTE');
    });

    test('non-integer overrideThreshold → falls back to consensusThreshold', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const d = await a.decide({
            snapshot: mkSnapshot(), votes: standardVotes(),
            triggeringSignal: mkSignal(), overrideThreshold: undefined
        });
        expect(d.outcome).toBe('EXECUTE'); // threshold=3, we have 3 LONG
    });

    test('overrideThreshold=4 with 3 LONG → HOLD', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const d = await a.decide({
            snapshot: mkSnapshot(), votes: standardVotes(),
            triggeringSignal: mkSignal(), overrideThreshold: 4
        });
        expect(d.outcome).toBe('HOLD');
    });

    // ── LLM integration ─────────────────────────────────────────────────

    test('STANDARD mode calls LLM when confidence < 0.5', async () => {
        const llm = mockLlm({ outcome: 'EXECUTE', direction: 'LONG', confidence: 0.8, reasoning: 'LLM says go' });
        const a = new Arbiter({ llm, mode: 'STANDARD', consensusThreshold: 3 });
        const votes = [
            mkVote('TechnicalAgent', 'LONG', 0.3),
            mkVote('BlackMirrorAgent', 'LONG', 0.2),
            mkVote('ChandelierAgent', 'LONG', 0.1),
            mkVote('SentimentAgent', 'NEUTRAL', 0),
            mkVote('RiskAgent', 'NEUTRAL', 0.5, { metrics: { sizing: { qty: 0.01 } } })
        ];
        const d = await a.decide({ snapshot: mkSnapshot(), votes, triggeringSignal: mkSignal() });
        expect(llm.askJson).toHaveBeenCalledTimes(1);
        expect(d.llmInvoked).toBe(true);
    });

    test('FAST mode never calls LLM', async () => {
        const llm = mockLlm();
        const a = new Arbiter({ llm, mode: 'FAST', consensusThreshold: 3 });
        await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });
        expect(llm.askJson).not.toHaveBeenCalled();
    });

    test('LLM failure → fallback to tally result', async () => {
        const llm = mockLlm(null); // LLM returns null
        const a = new Arbiter({ llm, mode: 'FULL', consensusThreshold: 3 });
        const d = await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });
        expect(d.llmInvoked).toBe(true);
        expect(d.outcome).toBe('EXECUTE');
        expect(d.direction).toBe('LONG');
    });

    // ── Historical context (Decision Memory) ─────────────────────────────

    test('historical_context injected into LLM prompt when db provided', async () => {
        const llm = mockLlm({ outcome: 'HOLD', direction: 'NEUTRAL', confidence: 0.3, reasoning: 'losses' });
        const db = mockDb([
            { direction: 'LONG', outcome: 'EXECUTE', confidence: 0.8, realized_pnl: -50, created_at: Date.now() - 86400000 }
        ]);
        const a = new Arbiter({ llm, mode: 'FULL', consensusThreshold: 3, db });
        await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });

        expect(db.getRecentDecisions).toHaveBeenCalledWith('BTCUSDT', 5);
        const userPrompt = JSON.parse(llm.askJson.mock.calls[0][0][1].content);
        expect(userPrompt.historical_context).toHaveLength(1);
        expect(userPrompt.historical_context[0].realized_pnl).toBe(-50);
    });

    test('db error is non-fatal → LLM still called with empty context', async () => {
        const llm = mockLlm({ outcome: 'HOLD', direction: 'NEUTRAL', confidence: 0.3, reasoning: 'ok' });
        const db = { getRecentDecisions: jest.fn().mockRejectedValue(new Error('db down')) };
        const a = new Arbiter({ llm, mode: 'FULL', consensusThreshold: 3, db });
        const d = await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });
        expect(d.llmInvoked).toBe(true);

        const userPrompt = JSON.parse(llm.askJson.mock.calls[0][0][1].content);
        expect(userPrompt.historical_context).toEqual([]);
    });

    test('no db → LLM called without historical_context query', async () => {
        const llm = mockLlm({ outcome: 'EXECUTE', direction: 'LONG', confidence: 0.9, reasoning: 'ok' });
        const a = new Arbiter({ llm, mode: 'FULL', consensusThreshold: 3 }); // no db
        await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });

        const userPrompt = JSON.parse(llm.askJson.mock.calls[0][0][1].content);
        expect(userPrompt.historical_context).toEqual([]);
    });

    // ── Debate protocol in system prompt ─────────────────────────────────

    test('systemPrompt contains debate protocol', async () => {
        const llm = mockLlm({ outcome: 'HOLD', direction: 'NEUTRAL', confidence: 0, reasoning: 'ok' });
        const a = new Arbiter({ llm, mode: 'FULL', consensusThreshold: 3 });
        await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });

        const sysPrompt = llm.askJson.mock.calls[0][0][0].content;
        expect(sysPrompt).toContain('Internal Debate Protocol');
        expect(sysPrompt).toContain('BULL CASE');
        expect(sysPrompt).toContain('BEAR CASE');
        expect(sysPrompt).toContain('VERDICT');
        expect(sysPrompt).toContain('🐂');
        expect(sysPrompt).toContain('🐻');
        expect(sysPrompt).toContain('RUSSIAN');
        expect(sysPrompt).toContain('historical_context');
    });

    // ── Tally logic ──────────────────────────────────────────────────────

    test('SHORT consensus with higher weight wins', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 2 });
        const votes = [
            mkVote('TechnicalAgent', 'SHORT', 0.9),
            mkVote('BlackMirrorAgent', 'SHORT', 0.8),
            mkVote('ChandelierAgent', 'LONG', 0.3),
            mkVote('RiskAgent', 'NEUTRAL', 0.5, { metrics: { sizing: { qty: 0.01 } } })
        ];
        const d = await a.decide({ snapshot: mkSnapshot(), votes, triggeringSignal: mkSignal() });
        expect(d.direction).toBe('SHORT');
        expect(d.outcome).toBe('EXECUTE');
    });

    // ── Decision structure ───────────────────────────────────────────────

    test('decision has all required fields', async () => {
        const a = new Arbiter({ mode: 'FAST', consensusThreshold: 3 });
        const d = await a.decide({ snapshot: mkSnapshot(), votes: standardVotes(), triggeringSignal: mkSignal() });
        expect(d).toHaveProperty('id');
        expect(d).toHaveProperty('symbol', 'BTCUSDT');
        expect(d).toHaveProperty('outcome');
        expect(d).toHaveProperty('direction');
        expect(d).toHaveProperty('confidence');
        expect(d).toHaveProperty('votes');
        expect(d).toHaveProperty('risk');
        expect(d).toHaveProperty('arbiterMode', 'FAST');
        expect(d).toHaveProperty('llmInvoked', false);
        expect(d).toHaveProperty('createdAt');
    });
});
