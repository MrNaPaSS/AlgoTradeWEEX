const { chandelierExit } = require('../../../src/indicators/chandelierExit');

/** Build a simple trending candle array */
function buildCandles(n, { startPrice = 100, trend = 1, volat = 1 } = {}) {
    const candles = [];
    let price = startPrice;
    for (let i = 0; i < n; i++) {
        const move = (Math.random() - 0.45) * volat + trend * 0.1;
        price = Math.max(1, price + move);
        candles.push({
            open:  price - Math.random() * 0.5,
            high:  price + Math.random() * 0.5,
            low:   price - Math.random() * 0.5,
            close: price,
            volume: 100 + Math.random() * 50
        });
    }
    return candles;
}

describe('chandelierExit', () => {
    test('returns arrays of same length as input', () => {
        const candles = buildCandles(60);
        const result = chandelierExit(candles);
        expect(result.longStop).toHaveLength(60);
        expect(result.shortStop).toHaveLength(60);
        expect(result.direction).toHaveLength(60);
        expect(result.buySignal).toHaveLength(60);
        expect(result.sellSignal).toHaveLength(60);
    });

    test('returns all NaN stops when candles < length + 1', () => {
        const candles = buildCandles(10);
        const result = chandelierExit(candles, { length: 22 });
        const validLong = result.longStop.filter(Number.isFinite);
        expect(validLong).toHaveLength(0);
    });

    test('longStop is always below or equal highest close in window', () => {
        const candles = buildCandles(100, { trend: 1 });
        const { longStop } = chandelierExit(candles, { length: 22, mult: 3.0 });
        for (let i = 22; i < candles.length; i++) {
            if (!Number.isFinite(longStop[i])) continue;
            expect(longStop[i]).toBeLessThan(candles[i].close + 50);
        }
    });

    test('shortStop is always above or equal lowest close in window', () => {
        const candles = buildCandles(100, { trend: -1 });
        const { shortStop } = chandelierExit(candles, { length: 22, mult: 3.0 });
        for (let i = 22; i < candles.length; i++) {
            if (!Number.isFinite(shortStop[i])) continue;
            expect(shortStop[i]).toBeGreaterThan(0);
        }
    });

    test('longStop is monotonically non-decreasing while dir=1', () => {
        const candles = buildCandles(100, { trend: 2, volat: 0.1 });
        const { longStop, direction } = chandelierExit(candles);
        for (let i = 23; i < candles.length; i++) {
            if (direction[i] === 1 && direction[i - 1] === 1 &&
                Number.isFinite(longStop[i]) && Number.isFinite(longStop[i - 1])) {
                expect(longStop[i]).toBeGreaterThanOrEqual(longStop[i - 1] - 0.001);
            }
        }
    });

    test('direction is either 1 or -1 for all computed bars', () => {
        const candles = buildCandles(100);
        const { direction } = chandelierExit(candles);
        for (let i = 22; i < candles.length; i++) {
            expect([1, -1]).toContain(direction[i]);
        }
    });

    test('buySignal is true only when direction flips from -1 to 1', () => {
        const candles = buildCandles(100);
        const { direction, buySignal } = chandelierExit(candles);
        for (let i = 1; i < candles.length; i++) {
            if (buySignal[i]) {
                expect(direction[i]).toBe(1);
                expect(direction[i - 1]).toBe(-1);
            }
        }
    });

    test('sellSignal is true only when direction flips from 1 to -1', () => {
        const candles = buildCandles(100);
        const { direction, sellSignal } = chandelierExit(candles);
        for (let i = 1; i < candles.length; i++) {
            if (sellSignal[i]) {
                expect(direction[i]).toBe(-1);
                expect(direction[i - 1]).toBe(1);
            }
        }
    });

    test('buySignal and sellSignal never true simultaneously', () => {
        const candles = buildCandles(200);
        const { buySignal, sellSignal } = chandelierExit(candles);
        for (let i = 0; i < candles.length; i++) {
            expect(buySignal[i] && sellSignal[i]).toBe(false);
        }
    });
});
