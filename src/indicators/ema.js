/**
 * Exponential Moving Average.
 * Pure function: (values, period) => number[] (same length as input; NaN where not enough data).
 */
function ema(values, period) {
    if (!Array.isArray(values)) throw new TypeError('[ema] values must be an array');
    if (!Number.isInteger(period) || period <= 0) {
        throw new RangeError('[ema] period must be a positive integer');
    }
    const out = new Array(values.length);
    if (values.length === 0) return out;

    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < values.length; i += 1) {
        if (i < period - 1) {
            sum += values[i];
            out[i] = NaN;
        } else if (i === period - 1) {
            sum += values[i];
            out[i] = sum / period;
        } else {
            out[i] = values[i] * k + out[i - 1] * (1 - k);
        }
    }
    return out;
}

module.exports = { ema };
