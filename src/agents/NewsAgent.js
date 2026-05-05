const { BaseAgent } = require('./BaseAgent');
const { createVote } = require('../domain/Vote');
const https = require('https');

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 минут (вы торгуете на 1h, так что запросы будут редкими)

/**
 * NewsAgent aggregates signal from NewsAPI.org
 * Uses the system LLM to evaluate the true sentiment of the headlines,
 * eliminating dictionary-based guesswork.
 */
class NewsAgent extends BaseAgent {
    constructor({ cacheTtlMs = CACHE_TTL_MS, apiToken, llm } = {}) {
        super('NewsAgent');
        this._cache = new Map(); // symbol → { vote, ts }
        this._cacheTtlMs = cacheTtlMs;
        this._apiToken = apiToken;
        this._llm = llm; // OpenRouterClient
    }

    async _analyze(snapshot) {
        if (!this._apiToken) {
            return createVote({
                agent: this.name, direction: 'NEUTRAL', confidence: 0,
                reasoning: 'NEWS_API_KEY is not configured'
            });
        }
        if (!this._llm?.isConfigured) {
            return createVote({
                agent: this.name, direction: 'NEUTRAL', confidence: 0,
                reasoning: 'LLM is not configured, cannot evaluate sentiment'
            });
        }

        const symbol = snapshot.symbol;
        const base = this._extractBase(symbol);
        if (!base) {
            return createVote({
                agent: this.name, direction: 'NEUTRAL', confidence: 0,
                reasoning: 'non-crypto or unrecognized symbol — news skipped'
            });
        }

        const cached = this._cache.get(base);
        if (cached && (Date.now() - cached.ts) < this._cacheTtlMs) {
            return cached.vote;
        }

        try {
            const news = await this._fetchNews(base);
            if (!news || news.length === 0) {
                return createVote({
                    agent: this.name, direction: 'NEUTRAL', confidence: 0,
                    reasoning: `no recent news for ${base}`
                });
            }

            const vote = await this._scoreNewsWithLlm(news, base);
            if (vote) {
                this._cache.set(base, { vote, ts: Date.now() });
                return vote;
            }
            
            return createVote({
                agent: this.name, direction: 'NEUTRAL', confidence: 0,
                reasoning: 'LLM failed to score news'
            });
        } catch (err) {
            return createVote({
                agent: this.name, direction: 'NEUTRAL', confidence: 0,
                reasoning: `news fetch failed: ${err.message}`
            });
        }
    }

    _extractBase(symbol) {
        // Запрашиваем только для наших основных проверенных монет
        const match = symbol.match(/^(BTC|ETH|SOL|BNB|XRP|ADA|XAUT)/i);
        return match ? match[1].toUpperCase() : null;
    }

    async _fetchNews(currency) {
        // Fetch last 10 articles
        const query = encodeURIComponent(`${currency} crypto`);
        const url = `https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${this._apiToken}`;
        const data = await this._get(url);
        return data?.articles || [];
    }

    async _scoreNewsWithLlm(articles, currency) {
        const headlines = articles.map(a => `- ${a.title}`).join('\n');
        
        const systemPrompt = [
            `You are a cryptocurrency market sentiment analyzer.`,
            `Evaluate the following recent news headlines for ${currency}.`,
            `Determine the overall market sentiment impact: LONG (bullish), SHORT (bearish), or NEUTRAL.`,
            `Calculate confidence between 0.0 and 1.0.`,
            `Provide a brief 1-sentence reasoning IN RUSSIAN.`,
            `Respond ONLY with JSON matching this exact schema:`,
            `{ "direction": "LONG"|"SHORT"|"NEUTRAL", "confidence": number, "reasoning": "string" }`
        ].join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Headlines for ${currency}:\n${headlines}` }
        ];

        const llmResult = await this._llm.askJson(messages);
        
        const resultObj = Array.isArray(llmResult) ? llmResult[0] : llmResult;
        
        if (!resultObj || !resultObj.direction) return null;

        return createVote({
            agent: this.name,
            direction: ['LONG', 'SHORT'].includes(resultObj.direction) ? resultObj.direction : 'NEUTRAL',
            confidence: Number.isFinite(resultObj.confidence) ? resultObj.confidence : 0,
            reasoning: resultObj.reasoning || `LLM evaluated ${articles.length} news articles.`,
            metrics: { articlesAnalyzed: articles.length }
        });
    }

    _get(url) {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { 'User-Agent': 'AlgoTrade-Agent' }, timeout: 8000 }, (res) => {
                let body = '';
                res.on('data', d => body += d);
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); }
                    catch (e) { reject(new Error('JSON parse error')); }
                });
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
        });
    }
}

module.exports = { NewsAgent };
