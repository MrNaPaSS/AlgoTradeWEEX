const { ema } = require('../../../src/indicators/ema');
const { rsi } = require('../../../src/indicators/rsi');
const { atr } = require('../../../src/indicators/atr');
const { volumeOscillator } = require('../../../src/indicators/volumeOscillator');

function buildPrices(n, { start = 100, trend = 0 } = {}) {
    const prices = [];
    let p = start;
    for (let i = 0; i < n; i++) {
        p = Math.max(1, p + trend + (Math.random() - 0.5) * 2);
        prices.push(p);
    }
    return prices;
}

function buildOHLCV(n) {
    const candles = [];
    let p = 100;
    for (let i = 0; i < n; i++) {
        p = Math.max(1, p + (Math.random() - 0.5) * 2);
        candles.push({ open: p, high: p + 1, low: p - 1, close: p, volume: 100 + Math.random() * 50 });
    }
    return candles;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────
describe('ema', () => {
    test('output length equals input length', () => {
        const prices = buildPrices(50);
        expect(ema(prices, 9)).toHaveLength(50);
    });

    test('first (period-1) values are NaN', () => {
        const prices = buildPrices(30);
        const result = ema(prices, 9);
        for (let i = 0; i < 8; i++) expect(isNaN(result[i])).toBe(true);
    });

    test('converges toward a constant series', () => {
        const prices = new Array(100).fill(50);
        const result = ema(prices, 9);
        const tail = result.slice(20).filter(Number.isFinite);
        tail.forEach(v => expect(Math.abs(v - 50)).toBeLessThan(0.01));
    });

    test('returns empty array for empty input', () => {
        expect(ema([], 9)).toHaveLength(0);
    });
});

// ─── RSI ─────────────────────────────────────────────────────────────────────
describe('rsi', () => {
    test('output length equals input length', () => {
        const prices = buildPrices(50);
        expect(rsi(prices, 14)).toHaveLength(50);
    });

    test('RSI values are in range 0-100 for finite values', () => {
        const prices = buildPrices(100);
        const result = rsi(prices, 14);
        result.filter(Number.isFinite).forEach(v => {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(100);
        });
    });

    test('pure uptrend yields RSI approaching 100', () => {
        const prices = Array.from({ length: 60 }, (_, i) => 100 + i);
        const result = rsi(prices, 14);
        const last = result[result.length - 1];
        expect(last).toBeGreaterThan(90);
    });

    test('pure downtrend yields RSI approaching 0', () => {
        const prices = Array.from({ length: 60 }, (_, i) => 160 - i);
        const result = rsi(prices, 14);
        const last = result[result.length - 1];
        expect(last).toBeLessThan(10);
    });
});

// ─── ATR ─────────────────────────────────────────────────────────────────────
describe('atr', () => {
    test('output length equals input length', () => {
        const candles = buildOHLCV(50);
        expect(atr(candles, 14)).toHaveLength(50);
    });

    test('ATR values are non-negative for finite values', () => {
        const candles = buildOHLCV(60);
        const result = atr(candles, 14);
        result.filter(Number.isFinite).forEach(v => expect(v).toBeGreaterThanOrEqual(0));
    });

    test('higher volatility candles produce higher ATR', () => {
        const lowVol = buildOHLCV(60).map(c => ({ ...c, high: c.close + 0.1, low: c.close - 0.1 }));
        const highVol = buildOHLCV(60).map(c => ({ ...c, high: c.close + 10, low: c.close - 10 }));
        const lowAtr = atr(lowVol, 14).filter(Number.isFinite);
        const highAtr = atr(highVol, 14).filter(Number.isFinite);
        const avgLow = lowAtr.reduce((a, b) => a + b, 0) / lowAtr.length;
        const avgHigh = highAtr.reduce((a, b) => a + b, 0) / highAtr.length;
        expect(avgHigh).toBeGreaterThan(avgLow);
    });
});

// ─── Volume Oscillator ────────────────────────────────────────────────────────
describe('volumeOscillator', () => {
    test('output length equals input length', () => {
        const volumes = Array.from({ length: 50 }, () => 100 + Math.random() * 50);
        expect(volumeOscillator(volumes)).toHaveLength(50);
    });

    test('rising volume trend yields positive VO', () => {
        const volumes = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
        const result = volumeOscillator(volumes, { short: 5, long: 14 });
        const finite = result.filter(Number.isFinite);
        const positiveCount = finite.filter(v => v > 0).length;
        expect(positiveCount).toBeGreaterThan(finite.length * 0.7);
    });
});
