const config = require('./src/config/config');
const { Database } = require('./src/services/database');
const { OpenRouterClient } = require('./src/llm/OpenRouterClient');
const { Arbiter } = require('./src/agents/Arbiter');
const { NewsAgent } = require('./src/agents/NewsAgent');

async function run() {
    console.log('--- Начинаем симуляцию консилиума ---');
    
    // 1. Инициализация (без реального брокера/ТГ)
    const db = new Database();
    await db.init();
    
    const llm = new OpenRouterClient({
        apiKey: config.openRouter.apiKey,
        model: config.openRouter.model
    });
    
    const arbiter = new Arbiter({
        llm,
        mode: 'STANDARD',
        consensusThreshold: 3,
        db
    });
    
    const newsAgent = new NewsAgent({ apiToken: config.external.newsApiKey, llm });

    const symbol = 'BTCUSDT';
    const snapshot = {
        symbol,
        tf: '1h',
        generatedAt: Date.now(),
        indicators: {
            close: 60000,
            atr: 1200
        }
    };
    
    const signal = { symbol, signalType: 'LONG', price: 60000, tf: '1h', id: 'sim_123' };

    console.log('\n[1] Агенты (Мок) голосуют...');
    
    // Создаем конфликтную ситуацию: 2 LONG, 1 SHORT, 1 NEUTRAL + NewsAgent
    const votes = [
        { agent: 'TechnicalAgent', direction: 'LONG', confidence: 0.6, veto: false, reasoning: 'Цена выше EMA' },
        { agent: 'SentimentAgent', direction: 'SHORT', confidence: 0.5, veto: false, reasoning: 'Индекс страха слишком высок' },
        { agent: 'ChandelierAgent', direction: 'LONG', confidence: 0.7, veto: false, reasoning: 'Тренд восходящий' },
        { agent: 'RiskAgent', direction: 'NEUTRAL', confidence: 0, veto: false, reasoning: 'Риски в норме', risk: { maxLoss: 100 } }
    ];
    
    console.log('Запускаем NewsAgent (LLM evaluation)...');
    try {
        const newsVote = await newsAgent.analyze(snapshot);
        votes.push(newsVote);
        console.log(`- NewsAgent: ${newsVote.direction} (confidence: ${newsVote.confidence})\n  Reason: ${newsVote.reasoning}`);
    } catch (e) {
        console.log(`- NewsAgent failed: ${e.message}`);
    }

    votes.forEach(v => {
        if(v.agent !== 'NewsAgent') console.log(`- ${v.agent}: ${v.direction} (confidence: ${v.confidence})`);
    });

    console.log('\n[2] Arbiter принимает решение (Адаптивный порог = 3)...');
    console.log('Голоса противоречивы, поэтому Arbiter должен вызвать LLM для дебатов!');
    
    const decision = await arbiter.decide({
        snapshot,
        votes,
        triggeringSignal: signal,
        overrideThreshold: 3
    });

    console.log('\n--- ИТОГОВОЕ РЕШЕНИЕ ---');
    console.log(`Outcome: ${decision.outcome}`);
    console.log(`Direction: ${decision.direction}`);
    console.log(`Confidence: ${decision.confidence}`);
    console.log(`LLM Invoked: ${decision.llmInvoked}`);
    console.log(`Reasoning: \n${decision.arbiterReasoning}`);
    
    process.exit(0);
}

run().catch(console.error);
