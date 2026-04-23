/**
 * Stochastic Oscillator (%K, %D).
 * %K = 100 * (close - lowest low) / (highest high - lowest low)
 * %D = SMA(%K, smoothD)
 */
function stochastic(candles, { periodK = 14, smoothK = 3, periodD = 3 } = {}) {
    const n = candles.length;
    const rawK = new Array(n).fill(NaN);
    for (let i = periodK - 1; i < n; i += 1) {
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - periodK + 1; j <= i; j += 1) {
            if (candles[j].high > hh) hh = candles[j].high;
            if (candles[j].low < ll) ll = candles[j].low;
        }
        const denom = hh - ll;
        rawK[i] = denom === 0 ? 50 : ((candles[i].close - ll) / denom) * 100;
    }

    const k = smooth(rawK, smoothK);
    const d = smooth(k, periodD);
    return { k, d };
}

function smooth(series, period) {
    const out = new Array(series.length).fill(NaN);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < series.length; i += 1) {
        if (Number.isFinite(series[i])) {
            sum += series[i];
            count += 1;
            if (count > period) {
                sum -= series[i - period];
                count = period;
            }
            if (count === period) out[i] = sum / period;
        }
    }
    return out;
}

module.exports = { stochastic };
