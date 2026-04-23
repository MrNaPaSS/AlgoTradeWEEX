const { bollinger } = require('../../../src/indicators/bollinger');
const { macd } = require('../../../src/indicators/macd');
const { stochastic } = require('../../../src/indicators/stochastic');

function mkCandles(n, seed = 1) {
    const out = [];
    let p = 100;
    for (let i = 0; i < n; i += 1) {
        p += Math.sin(i * seed * 0.3) * 2;
        out.push({ open: p, high: p + 1, low: p - 1, close: p, volume: 1000, timestamp: i });
    }
    return out;
}

describe('bollinger', () => {
    test('output arrays have correct length', () => {
        const values = mkCandles(100).map((c) => c.close);
        const b = bollinger(values, { period: 20, stdDev: 2 });
        expect(b.upper).toHaveLength(100);
        expect(b.middle).toHaveLength(100);
        expect(b.lower).toHaveLength(100);
    });

    test('upper ≥ middle ≥ lower for valid bands', () => {
        const values = mkCandles(100).map((c) => c.close);
        const b = bollinger(values);
        for (let i = 50; i < 100; i += 1) {
            if (Number.isFinite(b.upper[i])) {
                expect(b.upper[i]).toBeGreaterThanOrEqual(b.middle[i]);
                expect(b.middle[i]).toBeGreaterThanOrEqual(b.lower[i]);
            }
        }
    });

    test('warmup produces NaN', () => {
        const values = mkCandles(10).map((c) => c.close);
        const b = bollinger(values, { period: 20 });
        expect(b.upper.every((v) => Number.isNaN(v))).toBe(true);
    });
});

describe('macd', () => {
    test('arrays equal input length', () => {
        const values = mkCandles(100).map((c) => c.close);
        const m = macd(values);
        expect(m.macd).toHaveLength(100);
        expect(m.signal).toHaveLength(100);
        expect(m.histogram).toHaveLength(100);
    });

    test('histogram = macd - signal when both defined', () => {
        const values = mkCandles(100).map((c) => c.close);
        const m = macd(values);
        for (let i = 60; i < 100; i += 1) {
            if (Number.isFinite(m.histogram[i])) {
                expect(m.histogram[i]).toBeCloseTo(m.macd[i] - m.signal[i], 6);
            }
        }
    });
});

describe('stochastic', () => {
    test('%K is in [0, 100]', () => {
        const candles = mkCandles(100, 2);
        const s = stochastic(candles);
        for (const v of s.k) {
            if (Number.isFinite(v)) {
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThanOrEqual(100);
            }
        }
    });

    test('handles flat window (hh==ll) without NaN', () => {
        const flat = Array.from({ length: 30 }, (_, i) => ({
            open: 100, high: 100, low: 100, close: 100, volume: 1, timestamp: i
        }));
        const s = stochastic(flat);
        expect(s.k.some((v) => v === 50)).toBe(true);
    });
});
