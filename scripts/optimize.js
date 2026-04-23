#!/usr/bin/env node
/**
 * scripts/optimize.js — Grid Search Optimizer for Strategy Parameters
 * 
 * Iterates through combinations of ATR multipliers to find the sweet spot
 * for winrate and profit.
 */

process.env.LOG_LEVEL = 'error';
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { PositionManager } = require('../src/services/PositionManager');
const { PaperBroker } = require('../src/services/PaperBroker');
const { RiskGuard } = require('../src/services/riskGuard');
const { Database } = require('../src/services/database');
const { RiskAgent } = require('../src/agents/RiskAgent');
const { BlackMirrorAgent } = require('../src/agents/BlackMirrorAgent');
const { ChandelierAgent } = require('../src/agents/ChandelierAgent');
const { chandelierExit } = require('../src/indicators/chandelierExit');
const { blackMirrorScore } = require('../src/indicators/blackMirrorScore');
const { atr } = require('../src/indicators/atr');
const fs = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────
const SYMBOL = 'BTCUSDT';
const TF = '15m';
const BALANCE = 10000;
const RISK_PCT = 5;

const RANGES = {
    slAtr: [4.0, 5.0, 6.0],
    tp1Atr: [0.5, 1.0, 1.5],
    tp2Atr: [2.0, 3.0],
    tp3Atr: [4.0, 6.0],
    bmThreshold: [3, 4],
    ceLength: [22, 50],
    ceMult: [3.0, 4.0]
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function createMemoryDb() {
    const db = new Database();
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    db._db = new SQL.Database();
    
    // Read schema from database.js
    const schemaContent = fs.readFileSync(path.join(__dirname, '../src/services/database.js'), 'utf8');
    const schemaMatch = schemaContent.match(/const SCHEMA = `([\s\S]*?)`;/);
    if (schemaMatch) {
        db._db.exec(schemaMatch[1]);
        db._db.exec(`
            ALTER TABLE positions ADD COLUMN tp1_order_id TEXT;
            ALTER TABLE positions ADD COLUMN tp2_order_id TEXT;
            ALTER TABLE positions ADD COLUMN tp3_order_id TEXT;
        `);
    }
    
    db.run = (sql, params = []) => db._db.run(sql, params);
    db.get = (sql, params = []) => {
        const stmt = db._db.prepare(sql);
        stmt.bind(params);
        let res = undefined;
        if (stmt.step()) res = stmt.getAsObject();
        stmt.free();
        return res;
    };
    db.all = (sql, params = []) => {
        const stmt = db._db.prepare(sql);
        stmt.bind(params);
        const res = [];
        while (stmt.step()) res.push(stmt.getAsObject());
        stmt.free();
        return res;
    };
    return db;
}

async function runBacktest(candles, params) {
    const db = await createMemoryDb();
    const broker = new PaperBroker({ startingBalanceUsd: BALANCE, slippageBps: 2, takerFeeBps: 6 });
    const riskGuard = new RiskGuard({ 
        database: db,
        config: { maxDailyLossPercent: 100, maxConcurrentPositions: 10, correlationPenaltyEnabled: false },
        getAvailableBalanceUsd: () => broker.getAvailableBalanceUsd(),
        getOpenPositions: () => [] // Simplified
    });

    const agents = {
        blackMirror: new BlackMirrorAgent(),
        chandelier: new ChandelierAgent(),
        risk: new RiskAgent({
            riskGuard,
            riskConfig: { 
                slAtrMult: params.slAtr, 
                tp1AtrMult: params.tp1Atr, 
                tp2AtrMult: params.tp2Atr, 
                tp3AtrMult: params.tp3Atr, 
                maxPositionSizePercent: RISK_PCT, 
                defaultLeverage: 10, 
                testFixedNotionalUsd: BALANCE * (RISK_PCT / 100) 
            },
            getAvailableBalanceUsd: () => broker.getAvailableBalanceUsd()
        })
    };

    let totalPnL = 0;
    let wins = 0;
    let closes = 0;

    const pm = new PositionManager({
        database: db, broker, riskGuard, minNotionalUsd: 5,
        onEvent: (event, payload) => {
            if (event === 'positionClosed' || event === 'partialClose') {
                totalPnL += payload.pnl;
                if (event === 'positionClosed') {
                    closes++;
                    if (payload.pnl > 0) wins++;
                }
            }
        }
    });

    // Indicators (once for efficiency)
    const ceResult = chandelierExit(candles, { length: params.ceLength, mult: params.ceMult });
    const bmResult = blackMirrorScore(candles, { threshold: params.bmThreshold });
    const atrResult = atr(candles, 22);

    for (let i = 23; i < candles.length; i++) {
        const c = candles[i];
        const isGreen = c.close >= c.open;
        const ticks = isGreen ? [c.open, c.low, c.high, c.close] : [c.open, c.high, c.low, c.close];
        for (const price of ticks) await pm.onMarkPrice(SYMBOL, price);

        const window = candles.slice(0, i + 1);
        const lastIdx = window.length - 1;
        const snapshot = {
            symbol: SYMBOL, tf: TF, candles: window,
            indicators: {
                close: window[lastIdx].close,
                atr: atrResult[lastIdx],
                chandelier: {
                    direction: ceResult.direction[lastIdx],
                    buySignal: ceResult.buySignal[lastIdx],
                    sellSignal: ceResult.sellSignal[lastIdx]
                },
                blackMirror: {
                    scoreLong: bmResult.scoreLong[lastIdx],
                    scoreShort: bmResult.scoreShort[lastIdx],
                    longSignal: bmResult.longSignal[lastIdx],
                    shortSignal: bmResult.shortSignal[lastIdx]
                }
            }
        };

        const cVote = await agents.chandelier.analyze(snapshot);
        const bmVote = await agents.blackMirror.analyze(snapshot);
        
        const THRESHOLD = 0.85; // Ultra-strict entry
        let direction = null;
        if (cVote.direction === 'LONG' && bmVote.direction === 'LONG' && cVote.confidence >= THRESHOLD && bmVote.confidence >= 0.75) direction = 'LONG';
        if (cVote.direction === 'SHORT' && bmVote.direction === 'SHORT' && cVote.confidence >= THRESHOLD && bmVote.confidence >= 0.75) direction = 'SHORT';

        if (direction) {
            snapshot.triggeringSignal = { signalType: direction === 'LONG' ? 'CE_BUY' : 'CE_SELL', symbol: SYMBOL, price: c.close };
            const rVote = await agents.risk.analyze(snapshot);
            if (rVote.direction === direction && rVote.metrics?.sizing) {
                await pm.open({ symbol: SYMBOL, direction, markPrice: c.close, sizing: rVote.metrics.sizing, decisionId: `opt_${i}` });
            }
        }
    }

    await pm.forceCloseAll('opt_end');
    const winRate = closes > 0 ? (wins / closes) * 100 : 0;
    return { winRate, totalPnL, trades: closes };
}

async function main() {
    console.log(`[Optimizer] Starting grid search for ${SYMBOL} ${TF}...`);

    const client = new WeexFuturesClient({ apiKey: '', secretKey: '', passphrase: '' });
    const candles = await client.getCandles({ symbol: SYMBOL, tf: TF, limit: 1000 });
    console.log(`[Optimizer] Fetched ${candles.length} candles.`);

    const results = [];
    const totalCombinations = RANGES.slAtr.length * RANGES.tp1Atr.length * RANGES.tp2Atr.length * RANGES.tp3Atr.length;
    let count = 0;

    for (const sl of RANGES.slAtr) {
        for (const tp1 of RANGES.tp1Atr) {
            for (const tp2 of RANGES.tp2Atr) {
                for (const tp3 of RANGES.tp3Atr) {
                    for (const bmt of RANGES.bmThreshold) {
                        for (const cel of RANGES.ceLength) {
                            for (const cem of RANGES.ceMult) {
                                count++;
                                const params = { slAtr: sl, tp1Atr: tp1, tp2Atr: tp2, tp3Atr: tp3, bmThreshold: bmt, ceLength: cel, ceMult: cem };
                                process.stdout.write(`[Optimizer] Progress: ${count}/${totalCombinations} \r`);
                                const res = await runBacktest(candles, params);
                                results.push({ ...params, ...res });
                            }
                        }
                    }
                }
            }
        }
    }

    console.log('\n[Optimizer] Search complete.');
    const filtered = results.filter(r => r.trades >= 5);
    filtered.sort((a, b) => b.winRate - a.winRate || b.totalPnL - a.totalPnL);

    console.log('\nTop 10 Results (min 5 trades, by Winrate):');
    console.table(filtered.slice(0, 10).map(r => ({
        ...r,
        winRate: r.winRate.toFixed(1) + '%',
        totalPnL: '$' + r.totalPnL.toFixed(2)
    })));

    const best = filtered[0] || results[0];
    console.log('\nRECOMMENDED PARAMETERS:');
    console.log(`SL ATR:  ${best.slAtr}`);
    console.log(`TP1 ATR: ${best.tp1Atr}`);
    console.log(`TP2 ATR: ${best.tp2Atr}`);
    console.log(`TP3 ATR: ${best.tp3Atr}`);
    console.log(`Winrate: ${best.winRate.toFixed(1)}% | Trades: ${best.trades} | PnL: $${best.totalPnL.toFixed(2)}`);
}

main().catch(console.error);
