const { BlackMirrorAgent } = require('../../../src/agents/BlackMirrorAgent');

function buildSnapshot(scoreLong = 3, scoreShort = 0) {
    return {
        symbol: 'BTCUSDT',
        tf: '1h',
        candles: [],
        indicators: {
            blackMirror: {
                scoreLong,
                scoreShort,
                longSignal: scoreLong >= 3,
                shortSignal: scoreShort >= 3
            }
        }
    };
}

describe('BlackMirrorAgent', () => {
    let agent;
    beforeEach(() => { agent = new BlackMirrorAgent(); });

    test('returns LONG vote when scoreLong >= 3', async () => {
        const vote = await agent.analyze(buildSnapshot(3, 0));
        expect(vote.direction).toBe('LONG');
        expect(vote.confidence).toBeGreaterThan(0.5);
    });

    test('returns SHORT vote when scoreShort >= 3', async () => {
        const vote = await agent.analyze(buildSnapshot(0, 3));
        expect(vote.direction).toBe('SHORT');
        expect(vote.confidence).toBeGreaterThan(0.5);
    });

    test('returns NEUTRAL when score < 3 for both', async () => {
        const vote = await agent.analyze(buildSnapshot(2, 2));
        expect(vote.direction).toBe('NEUTRAL');
    });

    test('confidence scales with score: 4/4 > 3/4', async () => {
        const vote4 = await agent.analyze(buildSnapshot(4, 0));
        const vote3 = await agent.analyze(buildSnapshot(3, 0));
        expect(vote4.confidence).toBeGreaterThan(vote3.confidence);
    });

    test('returns NEUTRAL when indicators.blackMirror is missing', async () => {
        const vote = await agent.analyze({ symbol: 'BTCUSDT', tf: '1h', candles: [], indicators: {} });
        expect(vote.direction).toBe('NEUTRAL');
    });

    test('agent name is BlackMirrorAgent', () => {
        expect(agent.name).toBe('BlackMirrorAgent');
    });
});
