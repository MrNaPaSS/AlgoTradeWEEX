const { BaseAgent } = require('../../../src/agents/BaseAgent');
const { NEUTRAL_VOTE } = require('../../../src/domain/Vote');

// ── Concrete test agent ──────────────────────────────────────────────────────
class AlwaysBuyAgent extends BaseAgent {
    constructor() { super('AlwaysBuy'); }
    async _analyze() {
        return { agent: 'AlwaysBuy', direction: 'LONG', confidence: 0.9, veto: false, reasoning: 'test' };
    }
}

class ThrowingAgent extends BaseAgent {
    constructor() { super('Thrower'); }
    async _analyze() { throw new Error('simulated failure'); }
}

class NullReturningAgent extends BaseAgent {
    constructor() { super('NullReturn'); }
    async _analyze() { return null; }
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('BaseAgent', () => {
    test('cannot be instantiated directly', () => {
        expect(() => new BaseAgent('test')).toThrow('[BaseAgent] cannot be instantiated directly');
    });

    test('subclass analyze() returns vote from _analyze()', async () => {
        const agent = new AlwaysBuyAgent();
        const snapshot = { symbol: 'BTCUSDT', tf: '1h', candles: [], indicators: {} };
        const vote = await agent.analyze(snapshot);
        expect(vote.direction).toBe('LONG');
        expect(vote.confidence).toBe(0.9);
        expect(vote.agent).toBe('AlwaysBuy');
    });

    test('analyze() returns NEUTRAL_VOTE when _analyze() throws', async () => {
        const agent = new ThrowingAgent();
        const snapshot = { symbol: 'BTCUSDT', tf: '1h', candles: [], indicators: {} };
        const vote = await agent.analyze(snapshot);
        expect(vote.direction).toBe('NEUTRAL');
        expect(vote.agent).toBe('Thrower');
        expect(vote.reasoning).toContain('simulated failure');
    });

    test('analyze() returns NEUTRAL_VOTE when _analyze() returns null', async () => {
        const agent = new NullReturningAgent();
        const snapshot = { symbol: 'BTCUSDT', tf: '1h', candles: [], indicators: {} };
        const vote = await agent.analyze(snapshot);
        expect(vote.direction).toBe('NEUTRAL');
    });

    test('agent name is stored on instance', () => {
        const agent = new AlwaysBuyAgent();
        expect(agent.name).toBe('AlwaysBuy');
    });
});
