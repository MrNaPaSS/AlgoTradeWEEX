const OpenAI = require('openai');
const logger = require('../utils/logger');

/**
 * Thin wrapper over OpenRouter's OpenAI-compatible chat API.
 * Handles: timeout, JSON parsing, simple in-memory TTL cache.
 */
class OpenRouterClient {
    constructor({ apiKey, model, baseUrl = 'https://openrouter.ai/api/v1', timeoutMs = 15_000, cacheTtlSeconds = 10, maxRetries = 2, onMetric = null }) {
        this._apiKey = apiKey;
        this._model = model;
        this._timeoutMs = timeoutMs;
        this._cacheTtlMs = cacheTtlSeconds * 1000;
        this._maxRetries = Math.max(0, maxRetries);
        this._onMetric = typeof onMetric === 'function' ? onMetric : () => {};
        /** @type {Map<string, {value: any, expiresAt: number}>} */
        this._cache = new Map();

        this._client = apiKey
            ? new OpenAI({
                  apiKey,
                  baseURL: baseUrl,
                  timeout: timeoutMs,
                  defaultHeaders: {
                      'HTTP-Referer': 'https://github.com/kaktotakxm/algotrade-pro',
                      'X-Title': 'AlgoTrade Pro'
                  }
              })
            : null;
    }

    get isConfigured() {
        return this._client !== null;
    }

    _cacheKey(messages) {
        return JSON.stringify(messages);
    }

    _fromCache(key) {
        const hit = this._cache.get(key);
        if (!hit) return null;
        if (hit.expiresAt < Date.now()) {
            this._cache.delete(key);
            return null;
        }
        return hit.value;
    }

    _setCache(key, value) {
        this._cache.set(key, { value, expiresAt: Date.now() + this._cacheTtlMs });
    }

    /**
     * Ask the LLM for a JSON object matching the expected schema.
     * Returns parsed JSON, or null on any failure.
     *
     * @param {Array<{role:string, content:string}>} messages
     * @returns {Promise<Object|null>}
     */
    async askJson(messages) {
        if (!this._client) {
            logger.debug('[OpenRouter] not configured — returning null');
            return null;
        }
        const key = this._cacheKey(messages);
        const cached = this._fromCache(key);
        if (cached) {
            this._onMetric('llm_cache_hit');
            return cached;
        }

        let lastErr = null;
        for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
            const startedAt = Date.now();
            try {
                const completion = await this._client.chat.completions.create({
                    model: this._model,
                    messages,
                    response_format: { type: 'json_object' },
                    temperature: 0.2,
                    max_tokens: 600
                });
                const content = completion.choices?.[0]?.message?.content;
                if (!content) {
                    this._onMetric('llm_empty_response', { durationMs: Date.now() - startedAt });
                    return null;
                }
                const parsed = JSON.parse(content);
                this._setCache(key, parsed);
                this._onMetric('llm_success', { durationMs: Date.now() - startedAt, attempt });
                return parsed;
            } catch (err) {
                lastErr = err;
                const transient = /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|429|50\d/i.test(String(err.message || err));
                this._onMetric('llm_error', { message: err.message, attempt, transient, durationMs: Date.now() - startedAt });
                if (!transient || attempt === this._maxRetries) break;
                const backoffMs = Math.min(4000, 300 * Math.pow(2, attempt));
                await new Promise((r) => setTimeout(r, backoffMs));
            }
        }
        logger.warn('[OpenRouter] request failed after retries', { message: lastErr?.message, attempts: this._maxRetries + 1 });
        return null;
    }
}

module.exports = { OpenRouterClient };
