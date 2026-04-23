/**
 * Utility to aggregate candles from a lower timeframe to a higher one.
 */
class CandleAggregator {
    /**
     * @param {Array} candles - Array of OHLCV objects
     * @param {number} windowSize - Number of candles to group (e.g., 10 for 1m to 10m)
     * @returns {Array} - Aggregated candles
     */
    static aggregate(candles, windowSize) {
        if (!candles || candles.length === 0) return [];
        if (windowSize <= 1) return candles;

        const aggregated = [];
        for (let i = 0; i < candles.length; i += windowSize) {
            const slice = candles.slice(i, i + windowSize);
            if (slice.length < windowSize) break; // Optional: skip partial candles at the end

            const first = slice[0];
            const last = slice[slice.length - 1];

            let high = -Infinity;
            let low = Infinity;
            let volume = 0;

            for (const c of slice) {
                if (c.high > high) high = c.high;
                if (c.low < low) low = c.low;
                volume += (c.volume || 0);
            }

            aggregated.push({
                timestamp: first.timestamp,
                open: first.open,
                high: high,
                low: low,
                close: last.close,
                volume: volume
            });
        }
        return aggregated;
    }
}

module.exports = { CandleAggregator };
