const logger = require('../utils/logger');

/**
 * TradingOrchestrator — end-to-end pipeline:
 *   Signal → IndicatorSnapshot → Agents (parallel) → Arbiter (LLM) → RiskGuard → PositionManager
 */
class TradingOrchestrator {
    /**
     * @param {Object} opts
     * @param {import('./dataAggregator').DataAggregator} opts.dataAggregator
     * @param {import('./indicatorEngine').IndicatorEngine} opts.indicatorEngine
     * @param {import('../agents/BaseAgent').BaseAgent[]} opts.tradingAgents
     * @param {import('../agents/RiskAgent').RiskAgent} opts.riskAgent
     * @param {import('../agents/Arbiter').Arbiter} opts.arbiter
     * @param {import('./positionManager').PositionManager} opts.positionManager
     * @param {import('./database').Database} opts.database
     * @param {import('./riskGuard').RiskGuard} opts.riskGuard
     * @param {import('../api/weex/WeexFuturesClient')} opts.weexClient
     * @param {(event:string, payload:Object)=>void} [opts.onEvent]
     */
    constructor({
        dataAggregator,
        indicatorEngine,
        tradingAgents,
        riskAgent,
        arbiter,
        positionManager,
        database,
        riskGuard,
        weexClient,
        onEvent,
        config,
        userTradeEngine
    }) {
        this._data = dataAggregator;
        this._engine = indicatorEngine;
        this._tradingAgents = tradingAgents;
        this._riskAgent = riskAgent;
        this._arbiter = arbiter;
        this._pm = positionManager;
        this._db = database;
        this._risk = riskGuard;
        this._weex = weexClient;
        this._onEvent = onEvent || (() => {});
        this._config = config;
        this._userTradeEngine = userTradeEngine || null;

        // Периодическая синхронизация с биржей (раз в 30 секунд)
        this._syncInterval = null;
        if (this._pm && this._pm.syncWithExchange) {
            this._syncInterval = setInterval(() => {
                this._pm.syncWithExchange().catch((err) => {
                    logger.warn('[Orchestrator] periodic sync failed', { error: err.message });
                });
            }, 30000);
        }
    }

    /** Stop background tasks. Called on graceful shutdown. */
    dispose() {
        if (this._syncInterval) {
            clearInterval(this._syncInterval);
            this._syncInterval = null;
        }
    }

    /**
     * @param {import('../domain/types').Signal} signal
     * @returns {Promise<import('../domain/types').Decision|null>}
     */
    async handleSignal(signal) {
        const symbol = signal.symbol.toUpperCase();
        const tf = signal.tf;

        // --- Symbol Whitelist Check -----------------------------------------
        const allowedSymbols = (this._config?.trading?.symbols || []).map(s => s.toUpperCase());
        if (allowedSymbols.length > 0 && !allowedSymbols.includes(symbol)) {
            logger.info('[Orchestrator] signal dropped: symbol not in whitelist', { symbol, whitelist: allowedSymbols });
            return null;
        }

        if (this._risk?.isPaused) {
            logger.warn('[Orchestrator] trading paused — signal dropped', { symbol, signalId: signal.id });
            this._db.insertRiskEvent({
                eventType: 'SIGNAL_DROPPED_PAUSED', symbol,
                reason: 'trading paused', meta: { signalId: signal.id }
            }).catch((err) => logger.warn('[Orchestrator] insertRiskEvent failed', { message: err.message }));
            return null;
        }

        // ── 1. Проверка наличия данных ────────────────────────────────────────
        let candles = this._data.getCandles(symbol, tf);
        
        // Если свечей мало или нет, пробуем подгрузить историю принудительно
        if (!candles || candles.length < 30) {
            logger.info('[Orchestrator] fetching history due to insufficient data', { symbol, tf, current: candles?.length || 0 });
            try {
                // For 1s test signals, we use 1m candles for technical context
                const history = await this._weex.getCandles({ 
                    symbol, 
                    tf: tf === '1s' ? '1m' : tf, 
                    limit: 100 
                });
                if (history && history.length > 0) {
                    this._data.seedHistorical(symbol, tf, history);
                    candles = this._data.getCandles(symbol, tf);
                }
            } catch (err) {
                logger.warn('[Orchestrator] failed to fetch history on demand', { error: err.message });
            }
        }

        if (!candles || candles.length < 1) {
            logger.warn('[Orchestrator] still insufficient candles after fetch', { symbol, tf });
            return null;
        }

        const indicators = this._engine.compute(symbol, tf, candles);
        const snapshot = Object.freeze({
            symbol,
            tf,
            generatedAt: Date.now(),
            candles,
            indicators,
            triggeringSignal: signal
        });
        this._db.insertMarketSnapshot({
            symbol, tf,
            barTimestamp: candles[candles.length - 1].timestamp,
            indicators
        }).catch((err) => logger.warn('[Orchestrator] insertMarketSnapshot failed', { message: err.message }));

        const tradingVotes = await Promise.all(
            this._tradingAgents.map((a) => a.analyze(snapshot))
        );
        const riskVote = await this._riskAgent.analyze(snapshot);
        const allVotes = [...tradingVotes, riskVote];

        const decision = await this._arbiter.decide({
            snapshot, votes: allVotes, triggeringSignal: signal
        });
        const decisionRow = {
            decisionId: decision.id,
            signalId: decision.signalId,
            symbol: decision.symbol,
            outcome: decision.outcome,
            direction: decision.direction,
            confidence: decision.confidence,
            arbiterMode: decision.arbiterMode,
            llmInvoked: decision.llmInvoked,
            arbiterReasoning: decision.arbiterReasoning,
            votes: decision.votes,
            risk: decision.risk,
            createdAt: decision.createdAt
        };
        this._db.insertDecision(decisionRow).catch((err) => logger.warn('[Orchestrator] insertDecision failed', { message: err.message }));
        this._onEvent('decisionMade', { decision });

        if (decision.outcome !== 'EXECUTE' || decision.direction === 'NEUTRAL') {
            logger.info('[Orchestrator] decision not executable', {
                symbol, outcome: decision.outcome, direction: decision.direction
            });
            return decision;
        }

        const sizing = decision.risk?.sizing;
        if (!sizing) {
            logger.warn('[Orchestrator] execute decided but no sizing — aborting', { symbol });
            return decision;
        }

        const markPrice = indicators.close ?? candles[candles.length - 1].close;

        // C8 Bug Fix: If Arbiter flipped direction (e.g. Signal was LONG, but Arbiter decided SHORT),
        // the original 'sizing' from riskVote is invalid (SL/TP in wrong direction).
        // We MUST re-calculate sizing for the final direction.
        let finalSizing = sizing;
        if (decision.direction !== riskVote.direction) {
            logger.info('[Orchestrator] direction flip detected — re-calculating sizing', {
                original: riskVote.direction,
                final: decision.direction
            });
            // We use the internal _computeSizing of riskAgent to get fresh params
            const multiplier = riskVote.metrics?.sizingMultiplier || 1;
            const freshSizing = await this._riskAgent._computeSizing(snapshot, decision.direction, multiplier);
            if (!freshSizing) {
                logger.warn('[Orchestrator] failed to re-calculate sizing for flipped direction — aborting', { symbol });
                return decision;
            }
            finalSizing = freshSizing;
        }

        // 1. Master user (from .env) trades via original pipeline
        const position = await this._pm.open({
            symbol,
            direction: decision.direction,
            markPrice,
            sizing: finalSizing,
            decisionId: decision.id
        });

        if (position) {
            this._onEvent('positionExecuted', { decision, position });
        }

        // 2. Fan-out to all connected mini-app users
        let userResults = [];
        if (this._userTradeEngine) {
            userResults = await this._userTradeEngine.fanOutDecision(decision, snapshot);
        }

        // Attach user results to the decision object so the webhook router can see them
        decision.userResults = userResults;

        return decision;
    }

    onCandleClosed({ symbol, candle }) {
        // mark price = close; PositionManager handles exits.
        void this._pm.onMarkPrice(symbol, candle.close);
        
        // Forward mark price to all connected users
        if (this._userTradeEngine) {
            void this._userTradeEngine.onMarkPrice(symbol, candle.close);
        }
    }

    async getStatus() {
        const positions = this._pm.getOpen();
        const riskSnapshot = this._risk.snapshot();
        const stats = await this._db.getDailyStats();

        return {
            isLive: true,
            hasOpenPosition: positions.length > 0,
            openPosition: positions[0], // Simplified for single position status
            risk: riskSnapshot,
            stats: stats || {
                totalTrades: 0,
                winTrades: 0,
                lossTrades: 0,
                totalPnl: 0,
                winRate: 0,
                closedTrades: 0
            }
        };
    }

    /**
     * Emergency-close either a specific position, all positions on a symbol, or everything.
     * @param {{ positionId?: string, symbol?: string }} [opts]
     */
    async emergencyClose(opts = {}) {
        try {
            const positions = this._pm.getOpen();
            if (positions.length === 0) return { success: false, error: 'no open positions' };

            if (opts.positionId) {
                return await this._pm.closePosition(opts.positionId, 'EMERGENCY_MANUAL');
            }
            if (opts.symbol) {
                const onSymbol = positions.filter((p) => p.symbol === opts.symbol);
                if (onSymbol.length === 0) {
                    return { success: false, error: `no open positions on ${opts.symbol}` };
                }
                for (const p of onSymbol) {
                    await this._pm.closePosition(p.positionId, 'EMERGENCY_MANUAL');
                }
                return { success: true, closed: onSymbol.length };
            }
            await this._pm.forceCloseAll('EMERGENCY_MANUAL');
            return { success: true, closed: positions.length };
        } catch (err) {
            logger.error('[Orchestrator] emergencyClose failed', { message: err.message });
            return { success: false, error: err.message };
        }
    }
}

module.exports = { TradingOrchestrator };
