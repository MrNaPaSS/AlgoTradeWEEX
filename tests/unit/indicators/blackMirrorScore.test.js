const { blackMirrorScore } = require('../../../src/indicators/blackMirrorScore');

function buildCandles(n, { trend = 1, startPrice = 100 } = {}) {
    const candles = [];
    let price = startPrice;
    let vol = 1000;
    for (let i = 0; i < n; i++) {
        price = Math.max(1, price + trend * 0.2 + (Math.random() - 0.5) * 0.3);
        vol = Math.max(100, vol + (Math.random() - 0.5) * 50);
        candles.push({ open: price, high: price + 0.1, low: price - 0.1, close: price, volume: vol });
    }
    return candles;
}

describe('blackMirrorScore', () => {
    test('returns arrays of same length as input', () => {
        const candles = buildCandles(100);
        const result = blackMirrorScore(candles);
        expect(result.scoreLong).toHaveLength(100);
        expect(result.scoreShort).toHaveLength(100);
        expect(result.longSignal).toHaveLength(100);
        expect(result.shortSignal).toHaveLength(100);
    });

    test('score is always in range 0-4', () => {
        const candles = buildCandles(100);
        const { scoreLong, scoreShort } = blackMirrorScore(candles);
        for (let i = 0; i < candles.length; i++) {
            expect(scoreLong[i]).toBeGreaterThanOrEqual(0);
            expect(scoreLong[i]).toBeLessThanOrEqual(4);
            expect(scoreShort[i]).toBeGreaterThanOrEqual(0);
            expect(scoreShort[i]).toBeLessThanOrEqual(4);
        }
    });

    test('longSignal is true only when scoreLong >= threshold', () => {
        const candles = buildCandles(100);
        const threshold = 3;
        const { scoreLong, longSignal } = blackMirrorScore(candles, { threshold });
        for (let i = 0; i < candles.length; i++) {
            if (longSignal[i]) {
                expect(scoreLong[i]).toBeGreaterThanOrEqual(threshold);
            }
        }
    });

    test('shortSignal is true only when scoreShort >= threshold', () => {
        const candles = buildCandles(100);
        const threshold = 3;
        const { scoreShort, shortSignal } = blackMirrorScore(candles, { threshold });
        for (let i = 0; i < candles.length; i++) {
            if (shortSignal[i]) {
                expect(scoreShort[i]).toBeGreaterThanOrEqual(threshold);
            }
        }
    });

    test('with threshold=0 and useVolFilter=false all candles after warmup have signals', () => {
        const candles = buildCandles(100, { trend: 1 });
        const { longSignal } = blackMirrorScore(candles, { threshold: 0, useVolFilter: false });
        // After EMA warmup (50 bars) signals should all be true since threshold=0
        const afterWarmup = longSignal.slice(51);
        expect(afterWarmup.every(v => v === true)).toBe(true);
    });

    test('returns empty arrays for empty input', () => {
        const result = blackMirrorScore([]);
        expect(result.scoreLong).toHaveLength(0);
        expect(result.scoreShort).toHaveLength(0);
    });

    test('strong uptrend produces higher long scores than short scores', () => {
        const candles = buildCandles(150, { trend: 3, startPrice: 100 });
        const { scoreLong, scoreShort } = blackMirrorScore(candles, { useVolFilter: false });
        const avgLong = scoreLong.slice(60).reduce((a, b) => a + b, 0) / 90;
        const avgShort = scoreShort.slice(60).reduce((a, b) => a + b, 0) / 90;
        expect(avgLong).toBeGreaterThan(avgShort);
    });
});
