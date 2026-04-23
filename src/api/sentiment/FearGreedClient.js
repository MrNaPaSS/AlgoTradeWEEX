const axios = require('axios');
const logger = require('../../utils/logger');

/**
 * Crypto Fear & Greed Index client (alternative.me public API).
 */
class FearGreedClient {
    constructor({ baseUrl = 'https://api.alternative.me/fng/' } = {}) {
        this._baseUrl = baseUrl;
        this._cache = null;
        this._cachedAt = 0;
    }

    async getCurrent() {
        const nowMs = Date.now();
        if (this._cache && nowMs - this._cachedAt < 15 * 60 * 1000) {
            return this._cache;
        }
        try {
            const res = await axios.get(this._baseUrl, { params: { limit: 1 }, timeout: 5_000 });
            const entry = res.data?.data?.[0];
            if (!entry) return null;
            this._cache = {
                value: Number(entry.value),
                classification: entry.value_classification,
                timestamp: Number(entry.timestamp) * 1000
            };
            this._cachedAt = nowMs;
            return this._cache;
        } catch (err) {
            logger.warn('[FearGreed] fetch failed', { message: err.message });
            return this._cache; // stale cache OK
        }
    }
}

module.exports = { FearGreedClient };
