const { NewsAgent } = require('../../../src/agents/NewsAgent');

const snap = (symbol = 'BTCUSDT') => ({ symbol, tf: '1h', candles: [], indicators: {} });

const makeLlm = (resp = { direction: 'LONG', confidence: 0.7, reasoning: 'тест' }) => ({
    isConfigured: true,
    askJson: jest.fn().mockResolvedValue(resp)
});

function createAgent({ articles = [], llmResponse, apiToken = 'test-key', llm, cacheTtlMs } = {}) {
    const agent = new NewsAgent({
        apiToken,
        llm: llm || makeLlm(llmResponse),
        cacheTtlMs: cacheTtlMs ?? 15 * 60 * 1000
    });
    agent._get = jest.fn().mockResolvedValue({ articles });
    return agent;
}

describe('NewsAgent', () => {
    // ── Guard clauses ────────────────────────────────────────────────────
    test('NEUTRAL when API key missing', async () => {
        const agent = new NewsAgent({ apiToken: null, llm: makeLlm() });
        agent._get = jest.fn().mockResolvedValue({ articles: [] });
        const v = await agent._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('NEWS_API_KEY');
    });

    test('NEUTRAL when LLM not configured', async () => {
        const v = await createAgent({ llm: { isConfigured: false } })._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('LLM is not configured');
    });

    test('NEUTRAL for unrecognized symbol', async () => {
        const v = await createAgent()._analyze(snap('DOGEUSDT'));
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('non-crypto');
    });

    // ── _extractBase ─────────────────────────────────────────────────────
    test.each([
        ['BTCUSDT', 'BTC'], ['ETHUSDT', 'ETH'], ['SOLUSDT', 'SOL'],
        ['BNBUSDT', 'BNB'], ['XRPUSDT', 'XRP'], ['ADAUSDT', 'ADA'], ['XAUTUSDT', 'XAUT']
    ])('_extractBase("%s") → "%s"', (sym, exp) => {
        expect(new NewsAgent()._extractBase(sym)).toBe(exp);
    });

    test('_extractBase null for unsupported', () => {
        expect(new NewsAgent()._extractBase('DOGEUSDT')).toBeNull();
    });

    // ── LLM pipeline ─────────────────────────────────────────────────────
    test('bullish LLM → LONG', async () => {
        const v = await createAgent({
            articles: [{ title: 'ATH' }],
            llmResponse: { direction: 'LONG', confidence: 0.8, reasoning: 'бык' }
        })._analyze(snap());
        expect(v.direction).toBe('LONG');
        expect(v.confidence).toBe(0.8);
        expect(v.agent).toBe('NewsAgent');
    });

    test('bearish LLM → SHORT', async () => {
        const v = await createAgent({
            articles: [{ title: 'crash' }],
            llmResponse: { direction: 'SHORT', confidence: 0.6, reasoning: 'медведь' }
        })._analyze(snap());
        expect(v.direction).toBe('SHORT');
    });

    test('no articles → NEUTRAL', async () => {
        const v = await createAgent({ articles: [] })._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('no recent news');
    });

    test('LLM returns null → NEUTRAL', async () => {
        const a = createAgent({ articles: [{ title: 'x' }] });
        a._llm.askJson.mockResolvedValue(null);
        const v = await a._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('LLM failed');
    });

    test('LLM returns array → first element used', async () => {
        const a = createAgent({ articles: [{ title: 'x' }] });
        a._llm.askJson.mockResolvedValue([{ direction: 'SHORT', confidence: 0.9, reasoning: 'y' }]);
        const v = await a._analyze(snap());
        expect(v.direction).toBe('SHORT');
    });

    test('invalid direction from LLM → NEUTRAL', async () => {
        const a = createAgent({ articles: [{ title: 'x' }] });
        a._llm.askJson.mockResolvedValue({ direction: 'MAYBE', confidence: 0.5 });
        const v = await a._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
    });

    test('NaN confidence from LLM → 0', async () => {
        const v = await createAgent({
            articles: [{ title: 'x' }],
            llmResponse: { direction: 'LONG', confidence: NaN, reasoning: 'x' }
        })._analyze(snap());
        expect(v.confidence).toBe(0);
    });

    // ── Network errors ───────────────────────────────────────────────────
    test('fetch failure → NEUTRAL', async () => {
        const a = createAgent();
        a._get.mockRejectedValue(new Error('timeout'));
        const v = await a._analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.reasoning).toContain('timeout');
    });

    // ── Caching ──────────────────────────────────────────────────────────
    test('second call within TTL uses cache', async () => {
        const a = createAgent({
            articles: [{ title: 'x' }],
            llmResponse: { direction: 'LONG', confidence: 0.7, reasoning: 'c' }
        });
        const v1 = await a._analyze(snap());
        const v2 = await a._analyze(snap());
        expect(a._get).toHaveBeenCalledTimes(1);
        expect(v1).toBe(v2);
    });

    test('cache expires → re-fetches', async () => {
        const a = createAgent({
            articles: [{ title: 'x' }],
            llmResponse: { direction: 'LONG', confidence: 0.5, reasoning: 'f' },
            cacheTtlMs: 50
        });
        await a._analyze(snap());
        await new Promise(r => setTimeout(r, 80));
        await a._analyze(snap());
        expect(a._get).toHaveBeenCalledTimes(2);
    });

    test('different symbols → independent caches', async () => {
        const a = createAgent({
            articles: [{ title: 'x' }],
            llmResponse: { direction: 'LONG', confidence: 0.5, reasoning: 'x' }
        });
        await a._analyze(snap('BTCUSDT'));
        await a._analyze(snap('ETHUSDT'));
        expect(a._get).toHaveBeenCalledTimes(2);
    });

    // ── Prompt construction ──────────────────────────────────────────────
    test('headlines passed to LLM correctly', async () => {
        const llm = makeLlm({ direction: 'NEUTRAL', confidence: 0, reasoning: 'ok' });
        const a = createAgent({ articles: [{ title: 'Art1' }, { title: 'Art2' }], llm });
        await a._analyze(snap());
        const msgs = llm.askJson.mock.calls[0][0];
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe('system');
        expect(msgs[1].content).toContain('Art1');
        expect(msgs[1].content).toContain('Art2');
    });

    // ── Vote metadata ────────────────────────────────────────────────────
    test('vote includes articlesAnalyzed metric', async () => {
        const v = await createAgent({
            articles: [{ title: 'A' }, { title: 'B' }],
            llmResponse: { direction: 'LONG', confidence: 0.5, reasoning: 'ok' }
        })._analyze(snap());
        expect(v.metrics.articlesAnalyzed).toBe(2);
    });

    // ── BaseAgent integration ────────────────────────────────────────────
    test('analyze() catches _analyze errors', async () => {
        const a = createAgent();
        a._analyze = jest.fn().mockRejectedValue(new Error('boom'));
        const v = await a.analyze(snap());
        expect(v.direction).toBe('NEUTRAL');
        expect(v.agent).toBe('NewsAgent');
    });
});
