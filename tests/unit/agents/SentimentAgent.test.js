const { SentimentAgent } = require('../../../src/agents/SentimentAgent');

function snap(symbol, fearGreedIndex) {
    return { symbol, tf: '1h', candles: [], indicators: {}, fearGreedIndex, generatedAt: Date.now() };
}

describe('SentimentAgent', () => {
    const agent = new SentimentAgent();

    test('non-crypto symbol (XAUT) → NEUTRAL', async () => {
        const v = await agent.analyze(snap('XAUTUSDT', 10));
        expect(v.direction).toBe('NEUTRAL');
    });

    test('extreme fear → contrarian LONG', async () => {
        const v = await agent.analyze(snap('BTCUSDT', 10));
        expect(v.direction).toBe('LONG');
        expect(v.confidence).toBeGreaterThan(0);
    });

    test('extreme greed → contrarian SHORT', async () => {
        const v = await agent.analyze(snap('ETHUSDT', 90));
        expect(v.direction).toBe('SHORT');
        expect(v.confidence).toBeGreaterThan(0);
    });

    test('neutral band → NEUTRAL', async () => {
        const v = await agent.analyze(snap('BTCUSDT', 50));
        expect(v.direction).toBe('NEUTRAL');
    });

    test('missing fear-greed with no client → NEUTRAL', async () => {
        const v = await agent.analyze({ symbol: 'BTCUSDT', tf: '1h', indicators: {}, candles: [] });
        expect(v.direction).toBe('NEUTRAL');
    });

    test('uses injected client when fearGreedIndex missing', async () => {
        const client = { getCurrent: jest.fn().mockResolvedValue({ value: 5 }) };
        const a = new SentimentAgent({ fearGreedClient: client });
        const v = await a.analyze({ symbol: 'BTCUSDT', tf: '1h', indicators: {}, candles: [] });
        expect(client.getCurrent).toHaveBeenCalled();
        expect(v.direction).toBe('LONG');
    });
});
