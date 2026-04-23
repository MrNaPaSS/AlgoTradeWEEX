/**
 * Bollinger Bands (SMA + stdDev bands).
 */
function bollinger(values, { period = 20, stdDev = 2 } = {}) {
    const upper = new Array(values.length).fill(NaN);
    const middle = new Array(values.length).fill(NaN);
    const lower = new Array(values.length).fill(NaN);

    if (values.length < period) return { upper, middle, lower };

    let sum = 0;
    for (let i = 0; i < period; i += 1) sum += values[i];

    for (let i = period - 1; i < values.length; i += 1) {
        if (i > period - 1) sum += values[i] - values[i - period];
        const mean = sum / period;
        let variance = 0;
        for (let j = i - period + 1; j <= i; j += 1) {
            variance += (values[j] - mean) ** 2;
        }
        const sd = Math.sqrt(variance / period);
        upper[i] = mean + stdDev * sd;
        middle[i] = mean;
        lower[i] = mean - stdDev * sd;
    }
    return { upper, middle, lower };
}

module.exports = { bollinger };
