/**
 * Average True Range (Wilder smoothing).
 * @param {Array<{high: number, low: number, close: number}>} candles
 * @param {number} period
 * @returns {number[]} same length as candles
 */
function atr(candles, period = 14) {
    const out = new Array(candles.length).fill(NaN);
    if (candles.length < period + 1) return out;

    const trs = new Array(candles.length).fill(NaN);
    trs[0] = candles[0].high - candles[0].low;
    for (let i = 1; i < candles.length; i += 1) {
        const h = candles[i].high;
        const l = candles[i].low;
        const pc = candles[i - 1].close;
        trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }

    let sum = 0;
    for (let i = 1; i <= period; i += 1) sum += trs[i];
    out[period] = sum / period;

    for (let i = period + 1; i < candles.length; i += 1) {
        out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
    }
    return out;
}

module.exports = { atr };
