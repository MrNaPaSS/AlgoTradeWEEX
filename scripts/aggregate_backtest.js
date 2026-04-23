#!/usr/bin/env node
const fs = require('fs');
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const config = require('../src/config/config');
const { TechnicalAgent } = require('../src/agents/TechnicalAgent');
const { ChandelierAgent } = require('../src/agents/ChandelierAgent');
const { Arbiter } = require('../src/agents/Arbiter');
const { CandleAggregator } = require('../src/utils/CandleAggregator');
const { IndicatorEngine } = require('../src/services/indicatorEngine');

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc[val.slice(2)] = arr[i + 1];
    return acc;
}, {});

const SYMBOL    = (args.symbol || 'BTCUSDT').toUpperCase();
const TARGET_TF = args.tf || '10m';
const DAYS      = parseInt(args.days || '14');
const TO        = Date.now();
const FROM      = TO - DAYS * 86400_000;
const BALANCE   = 20000;

async function fetchAll1m(client, symbol, from, to) {
    const all = [];
    let currentFrom = from;
    const LIMIT = 1000;
    console.log(`[Backtest] Fetching 1m history for ${symbol}...`);
    while (currentFrom < to) {
        try {
            const batch = await client.getCandles({ symbol, tf: '1m', limit: LIMIT, startTime: currentFrom });
            if (!batch || batch.length === 0) break;
            all.push(...batch);
            const latest = batch[batch.length - 1].timestamp;
            if (latest >= to || batch.length < LIMIT) break;
            currentFrom = latest + 1;
            process.stdout.write(`.`);
            await new Promise(r => setTimeout(r, 200));
        } catch (err) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
    }
    console.log(`\n[Backtest] Total 1m candles: ${all.length}`);
    return all.sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
    const client = new WeexFuturesClient(config.weex);
    const raw = await fetchAll1m(client, SYMBOL, FROM, TO);
    
    let factor = 10;
    if (TARGET_TF === '5m') factor = 5;
    const candles = CandleAggregator.aggregate(raw, factor);
    console.log(`[Backtest] Aggregated -> ${candles.length} candles of ${TARGET_TF}`);

    const engine = new IndicatorEngine();
    const techAgent = new TechnicalAgent();
    const chanAgent = new ChandelierAgent();
    const arbiter   = new Arbiter({ mode: 'FAST', consensusThreshold: 1 });

    let balance = BALANCE, wins = 0, losses = 0, totalPnL = 0;
    let pos = null;

    for (let i = 100; i < candles.length; i++) {
        const history = candles.slice(0, i + 1);
        const computed = engine.compute(SYMBOL, TARGET_TF, history);
        const snapshot = { ...computed, symbol: SYMBOL, tf: TARGET_TF, indicators: computed };

        if (pos) {
            const pnl = pos.side === 'LONG' ? (snapshot.close - pos.entry)/pos.entry : (pos.entry - snapshot.close)/pos.entry;
            // Scalping: 0.5% SL, 1% TP
            if (pnl <= -0.005 || pnl >= 0.01) {
                const profit = balance * pnl * 10;
                balance += profit; totalPnL += profit;
                if (profit > 0) wins++; else losses++;
                pos = null;
            }
            continue;
        }

        const vTech = await techAgent.analyze(snapshot);
        const vChan = await chanAgent.analyze(snapshot);
        const vRisk = { agent: 'RiskAgent', direction: 'NEUTRAL', confidence: 1, veto: false, reasoning: 'MOCK ALLOW' };
        const decision = await arbiter.decide({ snapshot, votes: [vTech, vChan, vRisk] });
        
        if (decision.outcome === 'EXECUTE') {
            pos = { side: decision.direction === 'LONG' ? 'LONG' : 'SHORT', entry: snapshot.close };
        }
    }

    console.log('\n--------------------------------------------------------------');
    const winRate = ((wins / (wins + losses)) * 100 || 0).toFixed(1);
    const result = { symbol: SYMBOL, tf: TARGET_TF, winRate: winRate + '%', totalPnL: '$' + totalPnL.toFixed(2), totalCloses: wins + losses };
    console.table([result]);
}

main().catch(console.error);
