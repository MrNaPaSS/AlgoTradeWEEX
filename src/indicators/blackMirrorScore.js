const { ema } = require('./ema');
const { rsi } = require('./rsi');
const { volumeOscillator, volumeOscillatorSma } = require('./volumeOscillator');

/**
 * Port of the BLACK MIRROR ULTRA "Predictor" score (0–4):
 *   trend   : emaFast > emaSlow AND close > emaTrend      (for LONG)
 *   cross   : ta.crossover(emaFast, emaSlow)              (for LONG)
 *   rebound : RSI crosses low-zone up OR rising above low (for LONG)
 *   volume  : VO > 0 AND VO > VO_SMA                      (if filter enabled)
 *
 * Session filter is NOT applied here (we trade 24/7 per user decision).
 *
 * @param {Array<{close:number, volume:number}>} candles
 * @param {Object} [params]
 * @returns {{scoreLong:number[], scoreShort:number[], longSignal:boolean[], shortSignal:boolean[]}}
 */
function blackMirrorScore(
    candles,
    {
        emaFastLen = 8,
        emaSlowLen = 21,
        emaTrendLen = 50,
        rsiLen = 14,
        rsiLow = 35,
        rsiHigh = 65,
        volShort = 5,
        volLong = 14,
        volSmaLen = 10,
        useVolFilter = true,
        threshold = 3
    } = {}
) {
    const n = candles.length;
    const scoreLong = new Array(n).fill(0);
    const scoreShort = new Array(n).fill(0);
    const longSignal = new Array(n).fill(false);
    const shortSignal = new Array(n).fill(false);
    if (n === 0) return { scoreLong, scoreShort, longSignal, shortSignal };

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => (Number.isFinite(c.volume) ? c.volume : 1));

    const emaFast = ema(closes, emaFastLen);
    const emaSlow = ema(closes, emaSlowLen);
    const emaTrend = ema(closes, emaTrendLen);
    const rsiSeries = rsi(closes, rsiLen);
    const vo = volumeOscillator(volumes, { short: volShort, long: volLong });
    const voSma = volumeOscillatorSma(vo, { period: volSmaLen });

    for (let i = 1; i < n; i += 1) {
        const ef = emaFast[i];
        const es = emaSlow[i];
        const et = emaTrend[i];
        const efPrev = emaFast[i - 1];
        const esPrev = emaSlow[i - 1];
        const r = rsiSeries[i];
        const rPrev = rsiSeries[i - 1];
        const voVal = vo[i];
        const voSmaVal = voSma[i];

        if (![ef, es, et, r].every(Number.isFinite)) continue;

        const close = candles[i].close;

        // LONG score
        const trendUp = ef > es && close > et;
        const crossUp = Number.isFinite(efPrev) && Number.isFinite(esPrev) && efPrev <= esPrev && ef > es;
        const rsiReboundUp =
            Number.isFinite(rPrev) && ((rPrev <= rsiLow && r > rsiLow) || (r > rsiLow && r > rPrev));
        const volOkUp = useVolFilter
            ? Number.isFinite(voVal) && Number.isFinite(voSmaVal) && voVal > 0 && voVal > voSmaVal
            : true;
        const sL = (trendUp ? 1 : 0) + (crossUp ? 1 : 0) + (rsiReboundUp ? 1 : 0) + (volOkUp ? 1 : 0);
        scoreLong[i] = sL;
        longSignal[i] = sL >= threshold;

        // SHORT score
        const trendDn = ef < es && close < et;
        const crossDn = Number.isFinite(efPrev) && Number.isFinite(esPrev) && efPrev >= esPrev && ef < es;
        const rsiReboundDn =
            Number.isFinite(rPrev) && ((rPrev >= rsiHigh && r < rsiHigh) || (r < rsiHigh && r < rPrev));
        const volOkDn = useVolFilter
            ? Number.isFinite(voVal) && Number.isFinite(voSmaVal) && voVal < 0 && voVal < voSmaVal
            : true;
        const sS = (trendDn ? 1 : 0) + (crossDn ? 1 : 0) + (rsiReboundDn ? 1 : 0) + (volOkDn ? 1 : 0);
        scoreShort[i] = sS;
        shortSignal[i] = sS >= threshold;
    }

    return { scoreLong, scoreShort, longSignal, shortSignal };
}

module.exports = { blackMirrorScore };
