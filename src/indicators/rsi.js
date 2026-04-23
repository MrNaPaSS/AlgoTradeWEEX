/**
 * Relative Strength Index (Wilder's smoothing).
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]} same length as input (NaN where not enough data)
 */
function rsi(values, period = 14) {
    if (!Array.isArray(values)) throw new TypeError('[rsi] values must be an array');
    if (!Number.isInteger(period) || period <= 0) {
        throw new RangeError('[rsi] period must be a positive integer');
    }

    const out = new Array(values.length).fill(NaN);
    if (values.length <= period) return out;

    let gainSum = 0;
    let lossSum = 0;
    for (let i = 1; i <= period; i += 1) {
        const delta = values[i] - values[i - 1];
        if (delta >= 0) gainSum += delta;
        else lossSum -= delta;
    }
    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    out[period] = computeRsi(avgGain, avgLoss);

    for (let i = period + 1; i < values.length; i += 1) {
        const delta = values[i] - values[i - 1];
        const gain = delta > 0 ? delta : 0;
        const loss = delta < 0 ? -delta : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = computeRsi(avgGain, avgLoss);
    }
    return out;
}

function computeRsi(avgGain, avgLoss) {
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

module.exports = { rsi };
