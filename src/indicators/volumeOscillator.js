const { ema } = require('./ema');

/**
 * Volume Oscillator (percentage form):
 *   VO = (EMA(volume, short) - EMA(volume, long)) / EMA(volume, long) * 100
 *
 * Implements the same formula as BLACK MIRROR ULTRA (Pine Script).
 */
function volumeOscillator(volumes, { short = 5, long = 14 } = {}) {
    if (!Array.isArray(volumes)) throw new TypeError('[volumeOscillator] volumes must be array');
    const safeVols = volumes.map((v) => (Number.isFinite(v) && v > 0 ? v : 1));
    const shortEma = ema(safeVols, short);
    const longEma = ema(safeVols, long);
    return volumes.map((_, i) => {
        const s = shortEma[i];
        const l = longEma[i];
        if (!Number.isFinite(s) || !Number.isFinite(l) || l === 0) return NaN;
        return ((s - l) / l) * 100;
    });
}

/**
 * Simple moving average filter over a VO series.
 */
function volumeOscillatorSma(voSeries, { period = 10 } = {}) {
    const out = new Array(voSeries.length).fill(NaN);
    if (voSeries.length < period) return out;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < voSeries.length; i += 1) {
        const v = voSeries[i];
        if (Number.isFinite(v)) {
            sum += v;
            count += 1;
            if (count > period) {
                sum -= voSeries[i - period];
                count = period;
            }
            if (count === period) out[i] = sum / period;
        }
    }
    return out;
}

module.exports = { volumeOscillator, volumeOscillatorSma };
