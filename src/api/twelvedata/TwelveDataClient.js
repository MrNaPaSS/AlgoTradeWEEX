const axios = require('axios');
const logger = require('../../utils/logger');

/**
 * TwelveData REST client (fallback historical OHLCV).
 * Public docs: https://twelvedata.com/docs
 */
class TwelveDataClient {
    constructor({ apiKey, baseUrl = 'https://api.twelvedata.com' }) {
        this._apiKey = apiKey;
        this._http = axios.create({ baseURL: baseUrl, timeout: 10_000 });
    }

    get isConfigured() {
        return Boolean(this._apiKey);
    }

    async timeSeries({ symbol, interval = '1h', outputsize = 200 }) {
        if (!this.isConfigured) {
            throw new Error('[TwelveData] API key not configured');
        }
        try {
            const res = await this._http.get('/time_series', {
                params: { symbol, interval, outputsize, apikey: this._apiKey, format: 'JSON' }
            });
            const values = res.data?.values || [];
            return values
                .map((v) => ({
                    timestamp: new Date(v.datetime).getTime(),
                    open: Number(v.open),
                    high: Number(v.high),
                    low: Number(v.low),
                    close: Number(v.close),
                    volume: Number(v.volume || 0)
                }))
                .reverse();
        } catch (err) {
            logger.warn('[TwelveData] fetch failed', { message: err.message, symbol, interval });
            return [];
        }
    }
}

module.exports = { TwelveDataClient };
