const { atr } = require('./atr');

/**
 * Chandelier Exit — direct port of the Pine Script v6 logic from BLACK MIRROR ULTRA.
 *
 * Pseudo-code (Pine):
 *   atr = mult * ta.atr(length)
 *   longStop  = (useClose ? highest(close, length) : highest(high, length)) - atr
 *   longStop  := close[1] > longStopPrev ? max(longStop, longStopPrev) : longStop
 *   shortStop = (useClose ? lowest(close,  length) : lowest(low,   length)) + atr
 *   shortStop := close[1] < shortStopPrev ? min(shortStop, shortStopPrev) : shortStop
 *   dir := close > shortStopPrev ? 1 : close < longStopPrev ? -1 : dir
 *   buySignal  = dir == 1  and dir[1] == -1
 *   sellSignal = dir == -1 and dir[1] == 1
 *
 * @param {Array<{high:number, low:number, close:number}>} candles
 * @param {Object} [opts]
 * @returns {{longStop:number[], shortStop:number[], direction:number[], buySignal:boolean[], sellSignal:boolean[]}}
 */
function chandelierExit(candles, { length = 22, mult = 3.0, useClose = true } = {}) {
    const n = candles.length;
    const longStop = new Array(n).fill(NaN);
    const shortStop = new Array(n).fill(NaN);
    const direction = new Array(n).fill(1);
    const buySignal = new Array(n).fill(false);
    const sellSignal = new Array(n).fill(false);

    if (n < length + 1) {
        return { longStop, shortStop, direction, buySignal, sellSignal };
    }

    const atrSeries = atr(candles, length).map((v) => (Number.isFinite(v) ? v * mult : NaN));

    for (let i = length; i < n; i += 1) {
        const windowStart = i - length + 1;
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = windowStart; j <= i; j += 1) {
            const hi = useClose ? candles[j].close : candles[j].high;
            const lo = useClose ? candles[j].close : candles[j].low;
            if (hi > hh) hh = hi;
            if (lo < ll) ll = lo;
        }
        const atrVal = atrSeries[i];
        if (!Number.isFinite(atrVal)) continue;

        let ls = hh - atrVal;
        let ss = ll + atrVal;

        const prevLs = Number.isFinite(longStop[i - 1]) ? longStop[i - 1] : ls;
        const prevSs = Number.isFinite(shortStop[i - 1]) ? shortStop[i - 1] : ss;
        const prevClose = candles[i - 1].close;

        if (prevClose > prevLs) ls = Math.max(ls, prevLs);
        if (prevClose < prevSs) ss = Math.min(ss, prevSs);

        longStop[i] = ls;
        shortStop[i] = ss;

        const prevDir = direction[i - 1];
        let dir = prevDir;
        if (candles[i].close > prevSs) dir = 1;
        else if (candles[i].close < prevLs) dir = -1;
        direction[i] = dir;

        buySignal[i] = dir === 1 && prevDir === -1;
        sellSignal[i] = dir === -1 && prevDir === 1;
    }

    return { longStop, shortStop, direction, buySignal, sellSignal };
}

module.exports = { chandelierExit };
