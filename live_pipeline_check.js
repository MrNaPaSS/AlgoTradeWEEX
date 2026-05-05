/**
 * live_pipeline_check.js
 *
 * Боевая проверка полной цепочки: TradingView signal → все агенты → Arbiter (REAL LLM) → Decision
 *
 * РЕАЛЬНЫЕ вызовы:  OpenRouter (LLM), NewsAPI, Fear&Greed API
 * МОКИРУЕТСЯ ТОЛЬКО: positionManager.open() → НЕ выставляет ордер на бирже
 *
 * Запуск: node live_pipeline_check.js [LONG|SHORT] [SYMBOL]
 *   Примеры:
 *     node live_pipeline_check.js LONG BTCUSDT
 *     node live_pipeline_check.js SHORT ETHUSDT
 */

require('dotenv').config();

const { DataAggregator }      = require('./src/services/dataAggregator');
const { IndicatorEngine }     = require('./src/services/indicatorEngine');
const { TradingOrchestrator } = require('./src/services/tradingOrchestrator');
const { TechnicalAgent }      = require('./src/agents/TechnicalAgent');
const { BlackMirrorAgent }    = require('./src/agents/BlackMirrorAgent');
const { ChandelierAgent }     = require('./src/agents/ChandelierAgent');
const { SentimentAgent }      = require('./src/agents/SentimentAgent');
const { NewsAgent }           = require('./src/agents/NewsAgent');
const { RiskAgent }           = require('./src/agents/RiskAgent');
const { Arbiter }             = require('./src/agents/Arbiter');
const { RiskGuard }           = require('./src/services/riskGuard');
const { OpenRouterClient }    = require('./src/llm/OpenRouterClient');
const { FearGreedClient }     = require('./src/api/sentiment/FearGreedClient');
const { parseSignal }         = require('./src/domain/Signal');
const config                  = require('./src/config/config');

// ── CLI args ──────────────────────────────────────────────────────────────────
const signalArg  = (process.argv[2] || 'LONG').toUpperCase();   // LONG → CE_BUY, SHORT → CE_SELL
const symbolArg  = (process.argv[3] || 'BTCUSDT').toUpperCase();
const signalType = signalArg === 'SHORT' ? 'CE_SELL' : 'CE_BUY';

// ── Candle Generator (реалистичный BTC/ETH) ───────────────────────────────────
function generateCandles(basePrice, count = 150, opts = {}) {
    const { trend = 0, volatility = 0.008 } = opts;
    const candles = [];
    let price = basePrice;
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const noise = (Math.random() - 0.5) * 2 * volatility * price;
        price += trend * price + noise;
        if (price <= 0) price = basePrice * 0.5;
        const spread = price * volatility * 0.5;
        candles.push({
            timestamp: now - (count - i) * 3600000,
            open:   price - spread * 0.3,
            high:   price + spread,
            low:    price - spread,
            close:  price,
            volume: 100 + Math.random() * 500
        });
    }
    return candles;
}

// ── Mock DB (не пишем в продакшн БД) ─────────────────────────────────────────
function buildMockDb() {
    const decisions = [];
    return {
        insertMarketSnapshot: async () => {},
        insertDecision:       async (row) => { decisions.push(row); },
        insertRiskEvent:      async () => {},
        kvGet:                async () => null,
        kvSet:                async () => {},
        getDailyStats:        async () => ({ totalTrades: 0, winTrades: 0, lossTrades: 0, totalPnl: 0, winRate: 0, closedTrades: 0 }),
        getRecentDecisions:   async (symbol) => {
            // Возвращаем пустую историю — чистый старт
            console.log(`  [DB] getRecentDecisions(${symbol}) → [] (mock, нет истории)`);
            return [];
        },
        _decisions: decisions
    };
}

// ── Mock Position Manager (НЕ открывает ордер) ────────────────────────────────
function buildMockPm() {
    return {
        open: async (params) => {
            console.log('\n  ╔══════════════════════════════════════════════════╗');
            console.log('  ║  🚫 MOCK PM: open() вызван — ОРДЕР НЕ ВЫСТАВЛЕН ║');
            console.log('  ╚══════════════════════════════════════════════════╝');
            console.log('  Параметры которые ушли бы на биржу:');
            console.log('  ', JSON.stringify(params, null, 2));
            return { positionId: 'MOCK-' + Date.now(), symbol: params.symbol, direction: params.direction };
        },
        getOpen: () => [],
        syncWithExchange: null,
        onMarkPrice: async () => {}
    };
}

// ── Базовые цены по символам ──────────────────────────────────────────────────
const BASE_PRICES = {
    BTCUSDT:  96000,
    ETHUSDT:   1800,
    SOLUSDT:   145,
    BNBUSDT:   600,
    XRPUSDT:   2.2,
    XAUTUSDT: 3300,
};

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
    const basePrice = BASE_PRICES[symbolArg] || 100;
    const trendDir = signalArg === 'LONG' ? 0.0002 : -0.0002;

    console.log('═'.repeat(65));
    console.log(`  🤖 LIVE PIPELINE CHECK — ${symbolArg} ${signalType}`);
    console.log('═'.repeat(65));
    console.log(`  Модель LLM : ${config.openRouter.model}`);
    console.log(`  News API   : ${config.external.newsApiKey ? '✅ настроен' : '❌ не задан'}`);
    console.log(`  Цена       : ~${basePrice}`);
    console.log('─'.repeat(65));

    // 1. Candles
    const candles = generateCandles(basePrice, 150, { volatility: 0.008, trend: trendDir });
    const closePrice = candles[candles.length - 1].close;

    // 2. DataAggregator — seed свечами
    const dataAgg = new DataAggregator();
    dataAgg.seedHistorical(symbolArg, '1h', candles);

    // 3. REAL LLM
    const llm = new OpenRouterClient({
        apiKey:  config.openRouter.apiKey,
        model:   config.openRouter.model,
    });
    console.log(`  LLM isConfigured: ${llm.isConfigured}`);

    // 4. DB mock
    const db = buildMockDb();

    // 5. Arbiter с реальным LLM
    const arbiter = new Arbiter({ llm, mode: 'STANDARD', consensusThreshold: 3, db });

    // 6. Agents — REAL (SentimentAgent и NewsAgent делают реальные HTTP запросы)
    const technicalAgent  = new TechnicalAgent();
    const blackMirrorAgent= new BlackMirrorAgent();
    const chandelierAgent = new ChandelierAgent();
    const sentimentAgent  = new SentimentAgent({ fearGreedClient: new FearGreedClient() });
    const newsAgent       = new NewsAgent({ apiToken: config.external.newsApiKey, llm });

    console.log('\n[1/5] Агенты инициализированы (5 торговых + 1 Risk)');

    // 7. RiskGuard
    const getBalance = async () => 10000;
    const pm = buildMockPm();

    const riskGuard = new RiskGuard({
        config: {
            maxDailyLossPercent:        3,
            maxConcurrentPositions:     3,
            maxPositionSizePercent:     5,
            correlationVetoThreshold:   0.75,
            correlationPenaltyEnabled:  false,
            slAtrMult:                  2.0,
            tp1AtrMult:                 1.5,
            tp2AtrMult:                 3.0,
            tp3AtrMult:                 5.0,
            defaultLeverage:            5,
        },
        getAvailableBalanceUsd: getBalance,
        getOpenPositions: () => [],
        database: db,
    });
    // Без async init — ставим начальный баланс вручную (чтобы не писать в prod DB)
    riskGuard._startOfDayBalance = 10000;
    riskGuard._dayKey = new Date().toISOString().slice(0, 10);

    // 8. RiskAgent
    const riskAgent = new RiskAgent({
        riskGuard,
        riskConfig: config.risk,
        getAvailableBalanceUsd: getBalance,
    });

    // 9. Orchestrator
    const orchestrator = new TradingOrchestrator({
        dataAggregator:  dataAgg,
        indicatorEngine: new IndicatorEngine(),
        tradingAgents:   [technicalAgent, blackMirrorAgent, chandelierAgent, sentimentAgent, newsAgent],
        riskAgent,
        arbiter,
        positionManager: pm,
        database: db,
        riskGuard,
        weexClient: {
            // Если свечей не хватит — отдаём те же синтетические
            getCandles: async () => candles,
        },
        config: {
            trading: {
                symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'XAUTUSDT'],
                mode: 'paper',
            },
        },
    });

    // 10. Формируем сигнал точно как от TradingView
    const rawPayload = {
        secret:     config.webhook.secret,
        signalType: signalType,
        symbol:     symbolArg,
        tf:         '1h',
        price:      parseFloat(closePrice.toFixed(2)),
        longStop:   parseFloat((closePrice * 0.985).toFixed(2)),
        shortStop:  parseFloat((closePrice * 1.015).toFixed(2)),
    };

    let signal;
    try {
        signal = parseSignal(rawPayload);
    } catch (e) {
        console.error('❌ parseSignal failed:', e.message);
        process.exit(1);
    }

    console.log('\n[2/5] Сигнал TradingView:');
    console.log('  ', JSON.stringify({ ...rawPayload, id: signal.id }, null, 2));
    console.log('\n[3/5] Запускаем pipeline (реальные API вызовы)...\n');

    const t0 = Date.now();
    const decision = await orchestrator.handleSignal(signal);
    const elapsed = Date.now() - t0;

    if (!decision) {
        console.log('\n❌ Pipeline вернул null — сигнал дропнут (whitelist, паузa или нет свечей)');
        process.exit(0);
    }

    // ── Вывод результатов ────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(65));
    console.log('[4/5] ГОЛОСА АГЕНТОВ:');
    console.log('─'.repeat(65));
    for (const v of decision.votes || []) {
        const icon = v.direction === 'LONG' ? '🟢' : v.direction === 'SHORT' ? '🔴' : '⚪';
        const veto = v.veto ? ' ⛔VETO' : '';
        console.log(`  ${icon} ${v.agent.padEnd(20)} ${v.direction.padEnd(8)} conf=${(v.confidence * 100).toFixed(0).padStart(3)}%${veto}`);
        if (v.reasoning) console.log(`     └─ ${v.reasoning.slice(0, 120)}`);
    }

    const adaptiveThreshold = orchestrator._computeAdaptiveThreshold(
        new (require('./src/services/indicatorEngine').IndicatorEngine)().compute(symbolArg, '1h', candles)
    );

    console.log('\n[5/5] РЕШЕНИЕ АРБИТРА:');
    console.log('─'.repeat(65));
    console.log(`  Outcome   : ${decision.outcome}`);
    console.log(`  Direction : ${decision.direction}`);
    console.log(`  Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
    console.log(`  LLM вызван: ${decision.llmInvoked ? '✅ да' : '❌ нет (чистый tally)'}`);
    console.log(`  Порог     : ${adaptiveThreshold} из 5 агентов`);
    console.log(`  Время     : ${elapsed} мс`);

    if (decision.arbiterReasoning) {
        console.log('\n  Рассуждение LLM (Internal Debate):');
        console.log('  ' + '─'.repeat(60));
        // Форматируем дебаты — Bull/Bear/Verdict на отдельных строках
        const reasoning = decision.arbiterReasoning
            .replace(/🐂/g, '\n  🐂')
            .replace(/🐻/g, '\n  🐻')
            .replace(/✅/g, '\n  ✅')
            .trim();
        console.log('  ' + reasoning);
    }

    // Risk sizing если есть
    const riskVote = (decision.votes || []).find(v => v.agent === 'RiskAgent');
    if (riskVote?.metrics?.sizing) {
        const s = riskVote.metrics.sizing;
        const tps = s.takeProfits || [];
        console.log('\n  Risk Sizing (если бы открыли):');
        console.log(`    Qty        : ${s.quantity ?? s.qty ?? '?'}`);
        console.log(`    Notional   : $${s.notionalUsd ?? '?'}`);
        console.log(`    Leverage   : ${s.leverage}x`);
        console.log(`    StopLoss   : ${s.stopLoss}`);
        for (const tp of tps) {
            console.log(`    TP${tp.level} (${tp.closePercent}%): ${tp.price?.toFixed(2)}`);
        }
    }

    console.log('\n' + '═'.repeat(65));
    const outcomeIcon = decision.outcome === 'EXECUTE' ? '✅' : decision.outcome === 'HOLD' ? '⏸️ ' : '❌';
    console.log(`  ${outcomeIcon} ИТОГ: ${decision.outcome} ${decision.direction} на ${symbolArg}`);
    if (decision.outcome === 'EXECUTE') {
        console.log('  🚫 Ордер НЕ выставлен (mock PM — защита продакшна)');
    }
    console.log('═'.repeat(65));

    process.exit(0);
}

run().catch(err => {
    console.error('\n❌ ОШИБКА PIPELINE:', err.message);
    console.error(err.stack);
    process.exit(1);
});
