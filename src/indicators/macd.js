const { ema } = require('./ema');

/**
 * MACD (12, 26, 9 default).
 * Returns arrays of macd line, signal line, histogram (same length as input).
 */
function macd(values, { fast = 12, slow = 26, signal = 9 } = {}) {
    const fastArr = ema(values, fast);
    const slowArr = ema(values, slow);
    const macdLine = values.map((_, i) => {
        const f = fastArr[i];
        const s = slowArr[i];
        return Number.isFinite(f) && Number.isFinite(s) ? f - s : NaN;
    });
    const firstValid = macdLine.findIndex((v) => Number.isFinite(v));
    const signalInput = firstValid >= 0 ? macdLine.slice(firstValid) : [];
    const signalCompact = ema(signalInput, signal);
    const signalLine = new Array(values.length).fill(NaN);
    for (let i = 0; i < signalCompact.length; i += 1) {
        signalLine[firstValid + i] = signalCompact[i];
    }
    const histogram = values.map((_, i) => {
        const m = macdLine[i];
        const s = signalLine[i];
        return Number.isFinite(m) && Number.isFinite(s) ? m - s : NaN;
    });
    return { macd: macdLine, signal: signalLine, histogram };
}

module.exports = { macd };
