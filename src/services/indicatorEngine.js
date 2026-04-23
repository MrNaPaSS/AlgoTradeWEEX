const { ema } = require('../indicators/ema');
const { rsi } = require('../indicators/rsi');
const { macd } = require('../indicators/macd');
const { bollinger } = require('../indicators/bollinger');
const { atr } = require('../indicators/atr');
const { volumeOscillator } = require('../indicators/volumeOscillator');
const { chandelierExit } = require('../indicators/chandelierExit');
const { blackMirrorScore } = require('../indicators/blackMirrorScore');
const { stochastic } = require('../indicators/stochastic');

const DEFAULT_PARAMS = Object.freeze({
    emaFast: 8,
    emaSlow: 21,
    emaTrend: 50,
    rsi: 14,
    atr: 14,
    chandelierLength: 22,
    chandelierMult: 3.0
});

/**
 * IndicatorEngine computes a full snapshot for a symbol/timeframe from a candle series.
 * Pure (no I/O), deterministic, safe to call repeatedly.
 */
class IndicatorEngine {
    constructor({ params = {} } = {}) {
        this._params = { ...DEFAULT_PARAMS, ...params };
    }

    /**
     * @param {string} symbol
     * @param {string} tf
     * @param {Array<{timestamp:number,open:number,high:number,low:number,close:number,volume:number}>} candles
     * @returns {import('../domain/types').IndicatorSnapshot}
     */
    compute(symbol, tf, candles) {
        if (!Array.isArray(candles) || candles.length < 60) {
            throw new Error(`[IndicatorEngine] need >=60 candles, got ${candles?.length ?? 0}`);
        }
        const p = this._params;
        const closes = candles.map((c) => c.close);
        const volumes = candles.map((c) => c.volume);

        const emaFastArr = ema(closes, p.emaFast);
        const emaSlowArr = ema(closes, p.emaSlow);
        const emaTrendArr = ema(closes, p.emaTrend);
        const rsiArr = rsi(closes, p.rsi);
        const macdRes = macd(closes);
        const bbRes = bollinger(closes);
        const atrArr = atr(candles, p.atr);
        const voArr = volumeOscillator(volumes);
        const ce = chandelierExit(candles, { length: p.chandelierLength, mult: p.chandelierMult });
        const bm = blackMirrorScore(candles);
        const stoch = stochastic(candles);

        const i = candles.length - 1;
        return Object.freeze({
            symbol,
            tf,
            timestamp: candles[i].timestamp,
            close: candles[i].close,
            ema: Object.freeze({
                fast: emaFastArr[i],
                slow: emaSlowArr[i],
                trend: emaTrendArr[i]
            }),
            rsi: rsiArr[i],
            macd: Object.freeze({
                macd: macdRes.macd[i],
                signal: macdRes.signal[i],
                histogram: macdRes.histogram[i]
            }),
            bollinger: Object.freeze({
                upper: bbRes.upper[i],
                middle: bbRes.middle[i],
                lower: bbRes.lower[i]
            }),
            atr: atrArr[i],
            volumeOscillator: voArr[i],
            chandelier: Object.freeze({
                longStop: ce.longStop[i],
                shortStop: ce.shortStop[i],
                direction: ce.direction[i],
                buySignal: ce.buySignal[i],
                sellSignal: ce.sellSignal[i]
            }),
            blackMirror: Object.freeze({
                scoreLong: bm.scoreLong[i],
                scoreShort: bm.scoreShort[i],
                longSignal: bm.longSignal[i],
                shortSignal: bm.shortSignal[i]
            }),
            stochastic: Object.freeze({ k: stoch.k[i], d: stoch.d[i] })
        });
    }
}

module.exports = { IndicatorEngine, DEFAULT_PARAMS };
