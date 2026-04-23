const { TechnicalAgent } = require('../../../src/agents/TechnicalAgent');

function snap(indicators) {
    return { symbol: 'BTCUSDT', tf: '1h', candles: [], indicators, generatedAt: Date.now() };
}

describe('TechnicalAgent', () => {
    const agent = new TechnicalAgent();

    test('agent name', () => { expect(agent.name).toBe('TechnicalAgent'); });

    test('oversold indicators vote LONG', async () => {
        const vote = await agent.analyze(snap({
            rsi: 20,
            macd: { macd: 1, signal: 0.5, histogram: 0.5 },
            bollinger: { upper: 100, middle: 90, lower: 80 },
            stochastic: { k: 10, d: 15 },
            close: 79
        }));
        expect(vote.direction).toBe('LONG');
        expect(vote.confidence).toBeGreaterThan(0);
    });

    test('overbought indicators vote SHORT', async () => {
        const vote = await agent.analyze(snap({
            rsi: 80,
            macd: { macd: -1, signal: -0.5, histogram: -0.5 },
            bollinger: { upper: 100, middle: 90, lower: 80 },
            stochastic: { k: 90, d: 85 },
            close: 101
        }));
        expect(vote.direction).toBe('SHORT');
        expect(vote.confidence).toBeGreaterThan(0);
    });

    test('mixed / neutral indicators → NEUTRAL vote', async () => {
        const vote = await agent.analyze(snap({
            rsi: 50,
            macd: { macd: 0, signal: 0, histogram: 0 },
            bollinger: { upper: 100, middle: 90, lower: 80 },
            stochastic: { k: 50, d: 50 },
            close: 90
        }));
        expect(vote.direction).toBe('NEUTRAL');
        expect(vote.confidence).toBe(0);
    });

    test('confidence is in [0, 1]', async () => {
        const vote = await agent.analyze(snap({ rsi: 5, close: 0 }));
        expect(vote.confidence).toBeGreaterThanOrEqual(0);
        expect(vote.confidence).toBeLessThanOrEqual(1);
    });
});
