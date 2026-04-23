const { ChandelierAgent } = require('../../../src/agents/ChandelierAgent');

function snap(chandelier) {
    return { symbol: 'BTCUSDT', tf: '1h', candles: [], indicators: { chandelier }, generatedAt: Date.now() };
}

describe('ChandelierAgent', () => {
    const agent = new ChandelierAgent();

    test('buySignal → LONG high confidence', async () => {
        const v = await agent.analyze(snap({ direction: 1, buySignal: true, sellSignal: false, longStop: 100, shortStop: 110 }));
        expect(v.direction).toBe('LONG');
        expect(v.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('sellSignal → SHORT high confidence', async () => {
        const v = await agent.analyze(snap({ direction: -1, buySignal: false, sellSignal: true, longStop: 100, shortStop: 110 }));
        expect(v.direction).toBe('SHORT');
        expect(v.confidence).toBeGreaterThanOrEqual(0.8);
    });

    test('ongoing long trend → LONG medium confidence', async () => {
        const v = await agent.analyze(snap({ direction: 1, buySignal: false, sellSignal: false }));
        expect(v.direction).toBe('LONG');
        expect(v.confidence).toBeLessThan(0.8);
    });

    test('ongoing short trend → SHORT medium confidence', async () => {
        const v = await agent.analyze(snap({ direction: -1, buySignal: false, sellSignal: false }));
        expect(v.direction).toBe('SHORT');
    });

    test('missing chandelier → NEUTRAL', async () => {
        const v = await agent.analyze({ symbol: 'X', tf: '1h', indicators: {}, candles: [], generatedAt: Date.now() });
        expect(v.direction).toBe('NEUTRAL');
    });
});
