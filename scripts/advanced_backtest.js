#!/usr/bin/env node
/**
 * scripts/advanced_backtest.js — Advanced strategy backtester
 *
 * Uses the actual PositionManager, PaperBroker, and RiskAgent to simulate exactly
 * how the bot would behave in live/paper mode, including the new TP ladder and
 * breakeven SL mechanics. Runs entirely in memory.
 *
 * Usage:
 *   node scripts/advanced_backtest.js --symbol BTCUSDT --tf 1h --from 2026-01-01
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { PositionManager } = require('../src/services/PositionManager');
const { PaperBroker } = require('../src/services/PaperBroker');
const { RiskGuard } = require('../src/services/riskGuard');
const { Database } = require('../src/services/database');
const { RiskAgent } = require('../src/agents/RiskAgent');
const { TechnicalAgent } = require('../src/agents/TechnicalAgent');
const { BlackMirrorAgent } = require('../src/agents/BlackMirrorAgent');
const { ChandelierAgent } = require('../src/agents/ChandelierAgent');
const { Arbiter } = require('../src/agents/Arbiter');
const { createVote } = require('../src/domain/Vote');
const { OpenRouterClient } = require('../src/llm/OpenRouterClient');
const { chandelierExit } = require('../src/indicators/chandelierExit');
const { blackMirrorScore } = require('../src/indicators/blackMirrorScore');
const { atr } = require('../src/indicators/atr');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc[val.slice(2)] = arr[i + 1];
    return acc;
}, {});

const SYMBOL    = (args.symbol || 'BTCUSDT').toUpperCase();
const TF        = args.tf     || '1h';
const FROM      = args.from   ? new Date(args.from).getTime() : Date.now() - 90 * 86400_000;
const TO        = args.to     ? new Date(args.to).getTime()   : Date.now();
const USE_ARBITER = process.argv.includes('--arbiter');

const LEVERAGE  = parseFloat(args.leverage  || '5');
const RISK_PCT  = parseFloat(args.risk      || '1');   // % of balance per trade
const BALANCE   = parseFloat(args.balance   || '10000');
const SL_ATR    = parseFloat(args.slAtr     || '2.0');
const TP1_ATR   = parseFloat(args.tp1Atr    || '1.5');
const TP2_ATR   = parseFloat(args.tp2Atr    || '3.0');
const TP3_ATR   = parseFloat(args.tp3Atr    || '5.0');

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(a, b) { return ((a - b) / b) * 100; }
function round(n, d = 2) { return Math.round(n * 10 ** d) / 10 ** d; }

async function fetchAllCandles(client, symbol, tf) {
    const allCandles = [];
    const LIMIT = 1000;
    let endTime = TO;

    let startTime = FROM;
    console.log(`[Backtest] Fetching ${symbol} ${tf} candles from WEEX starting from ${new Date(startTime).toISOString()}...`);
    
    while (true) {
        const batch = await client.getCandles({ symbol, tf, limit: LIMIT, startTime });
        if (!batch || batch.length === 0) break;
        
        batch.sort((a, b) => a.timestamp - b.timestamp);
        const earliest = batch[0].timestamp;
        const latest = batch[batch.length - 1].timestamp;
        
        console.log(`[Backtest] Received ${batch.length} candles. Range: ${new Date(earliest).toISOString()} to ${new Date(latest).toISOString()}`);
        
        // Avoid infinite loop if API returns the same data
        if (allCandles.length > 0 && earliest === allCandles[allCandles.length - 1].timestamp) {
            console.log('[Backtest] Received duplicate earliest candle. Breaking.');
            break;
        }

        allCandles.push(...batch);
        
        console.log(`[Backtest] Single batch fetched. Total: ${allCandles.length} candles.`);
        break;
        
        if (latest >= TO) break;
        startTime = latest + 1;
        await new Promise(r => setTimeout(r, 100));
    }

    return allCandles
        .filter(c => c.timestamp >= FROM && c.timestamp <= TO)
        .sort((a, b) => a.timestamp - b.timestamp);
}

// Memory-only DB setup for insane speed
async function createMemoryDb() {
    const db = new Database();
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    db._db = new SQL.Database();
    
    // Read schema
    const schemaContent = fs.readFileSync(path.join(__dirname, '../src/services/database.js'), 'utf8');
    const schemaMatch = schemaContent.match(/const SCHEMA = `([\s\S]*?)`;/);
    if (schemaMatch) {
        db._db.exec(schemaMatch[1]);
        db._migrateSchema = () => {}; // mock migration
        // Force migration logic
        db._db.exec(`
            ALTER TABLE positions ADD COLUMN tp1_order_id TEXT;
            ALTER TABLE positions ADD COLUMN tp2_order_id TEXT;
            ALTER TABLE positions ADD COLUMN tp3_order_id TEXT;
        `);
    }
    
    // Override methods that persist to disk
    db._markDirty = () => {};
    db._ensureSchemaVersion = () => {};
    db.run = function(sql, params = []) {
        this._db.run(sql, params);
    };
    db.get = function(sql, params = []) {
        const stmt = this._db.prepare(sql);
        stmt.bind(params);
        let res = undefined;
        if (stmt.step()) res = stmt.getAsObject();
        stmt.free();
        return res;
    };
    db.all = function(sql, params = []) {
        const stmt = this._db.prepare(sql);
        stmt.bind(params);
        const res = [];
        while (stmt.step()) res.push(stmt.getAsObject());
        stmt.free();
        return res;
    };
    
    return db;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`[Backtest] ${SYMBOL} ${TF} | ${new Date(FROM).toISOString()} → ${new Date(TO).toISOString()}`);
    
    const client = new WeexFuturesClient({
        apiKey: process.env.WEEX_API_KEY || '',
        secretKey: process.env.WEEX_SECRET_KEY || '',
        passphrase: process.env.WEEX_PASSPHRASE || ''
    });

    const candles = await fetchAllCandles(client, SYMBOL, TF);
    const candles4h = await client.getCandles({ symbol: SYMBOL, tf: '4h', limit: 500 });
    
    if (candles.length < 50 || candles4h.length < 60) {
        console.error('[Backtest] Not enough candles (need 4h for trend filter)');
        process.exit(1);
    }
    
    // Calculate 4h EMA 50 for trend filter
    const { ema } = require('../src/indicators/ema');
    const ema4h = ema(candles4h.map(c => c.close), 50);
    
    // Setup In-Memory Environment
    const db = await createMemoryDb();
    const broker = new PaperBroker({ startingBalanceUsd: BALANCE, slippageBps: 2, takerFeeBps: 6 });
    
    const riskGuard = new RiskGuard({ 
        database: db,
        config: { maxDailyLossPercent: 100, maxConcurrentPositions: 10, correlationPenaltyEnabled: false },
        getAvailableBalanceUsd: () => broker.getAvailableBalanceUsd(),
        getOpenPositions: () => pm?.getOpen() || []
    });
    
    // Setup Agents
    const agents = {
        technical: new TechnicalAgent(),
        blackMirror: new BlackMirrorAgent(),
        chandelier: new ChandelierAgent(),
        risk: new RiskAgent({
            riskGuard,
            riskConfig: { 
                slAtrMult: SL_ATR, tp1AtrMult: TP1_ATR, tp2AtrMult: TP2_ATR, tp3AtrMult: TP3_ATR, 
                maxPositionSizePercent: RISK_PCT, defaultLeverage: LEVERAGE, testFixedNotionalUsd: BALANCE * (RISK_PCT / 100) 
            },
            getAvailableBalanceUsd: () => broker.getAvailableBalanceUsd()
        })
    };

    let arbiter = null;
    if (USE_ARBITER) {
        const llm = new OpenRouterClient({
            apiKey: process.env.OPENROUTER_API_KEY,
            model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'
        });
        arbiter = new Arbiter({ llm, mode: 'STANDARD', consensusThreshold: 1 });
    }

    const tradesList = [];
    const pm = new PositionManager({
        database: db,
        broker,
        riskGuard,
        minNotionalUsd: 5,
        onEvent: (event, payload) => {
            // console.log(`[Backtest] Event: ${event}`);
            if (event === 'positionOpened') {
                tradesList.push({
                    date: new Date(currentTimestamp).toISOString(),
                    symbol: payload.position.symbol,
                    side: payload.position.side,
                    action: 'OPEN',
                    price: payload.position.entryPrice,
                    balance: broker.getAvailableBalanceUsd()
                });
            } else if (event === 'positionClosed' || event === 'partialClose') {
                const isFull = event === 'positionClosed';
                tradesList.push({
                    date: new Date(currentTimestamp).toISOString(),
                    symbol: payload.position.symbol,
                    side: payload.position.side,
                    action: isFull ? 'CLOSE_FULL' : `CLOSE_PARTIAL_TP${payload.level}`,
                    pnlUSDT: payload.pnl,
                    balance: broker.getAvailableBalanceUsd(),
                    reason: payload.reason || `TP${payload.level}`
                });
            }
        }
    });

    let currentTimestamp = 0;
    
    console.log(`[Backtest] Simulating ${candles.length} candles with intra-candle price paths...`);
    console.log('--- STARTING SIMULATION ---');
    
    for (let i = 23; i < candles.length; i++) {
        const c = candles[i];
        currentTimestamp = c.timestamp;
        
        // 1. Intra-candle tick simulation for accurate TP/SL
        // If green candle: open -> low -> high -> close
        // If red candle: open -> high -> low -> close
        const isGreen = c.close >= c.open;
        const ticks = isGreen 
            ? [c.open, c.low, c.high, c.close]
            : [c.open, c.high, c.low, c.close];
            
        for (const price of ticks) {
            await pm.onMarkPrice(SYMBOL, price);
        }
        
        // 2. Evaluate entry logic at the close of the candle
        const window = candles.slice(0, i + 1);
        
        // Find 4h trend at current timestamp
        const last4hCandle = candles4h.filter(c4 => c4.timestamp <= c.timestamp).pop();
        const last4hIdx = candles4h.indexOf(last4hCandle);
        const trend4h = (last4hCandle && ema4h[last4hIdx]) ? (last4hCandle.close > ema4h[last4hIdx] ? 'LONG' : 'SHORT') : 'NEUTRAL';
        
        // Build snapshot with indicators for agents
        const ceResult = chandelierExit(window, { length: 22, mult: 3.0 });
        const bmResult = blackMirrorScore(window);
        const atrResult = atr(window, 22);
        
        const lastIdx = window.length - 1;
        const snapshot = {
            symbol: SYMBOL,
            tf: TF,
            candles: window,
            indicators: {
                close: window[lastIdx].close,
                atr: atrResult[lastIdx],
                chandelier: {
                    longStop: ceResult.longStop[lastIdx],
                    shortStop: ceResult.shortStop[lastIdx],
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
        
        // Add triggering signal to snapshot for RiskAgent
        snapshot.triggeringSignal = {
            signalType: cVote.direction === 'LONG' ? 'CE_BUY' : 'CE_SELL',
            symbol: SYMBOL,
            price: window[lastIdx].close
        };
        
        const rVote = await agents.risk.analyze(snapshot);
        
        let decision;
        if (USE_ARBITER) {
            const maybeDirection = cVote.direction;
            if (maybeDirection !== 'NEUTRAL' && maybeDirection === trend4h) {
                decision = await arbiter.decide({
                    snapshot,
                    votes: [cVote, bmVote, rVote],
                    triggeringSignal: snapshot.triggeringSignal
                });
            } else {
                decision = { outcome: 'HOLD', arbiterReasoning: `Trend mismatch (HTF=${trend4h})` };
            }
        } else {
        // Logic for ONLY Chandelier signals (BY/SL)
        let direction = 'NEUTRAL';
        const THRESHOLD = 0.85; // Strict for BY/SL labels
        if (cVote.direction === 'LONG' && cVote.confidence >= THRESHOLD && trend4h === 'LONG') direction = 'LONG';
        else if (cVote.direction === 'SHORT' && cVote.confidence >= THRESHOLD && trend4h === 'SHORT') direction = 'SHORT';
        
        const isVetoed = rVote.veto || rVote.direction === 'NEUTRAL' || rVote.direction !== direction;
            decision = {
                outcome: (direction !== 'NEUTRAL' && !isVetoed) ? 'EXECUTE' : 'HOLD',
                direction,
                confidence: Math.max(cVote.confidence, bmVote.confidence),
                risk: { allow: !isVetoed, sizing: rVote.metrics?.sizing },
                arbiterReasoning: `Manual: ${direction} risk=${!isVetoed} trend4h=${trend4h}`
            };
        }

        if (decision.outcome === 'EXECUTE') {
            const pos = await pm.open({
                symbol: SYMBOL,
                direction: decision.direction,
                markPrice: c.close,
                sizing: decision.risk.sizing,
                decisionId: `bt_${c.timestamp}`
            });
            
            if (pos) {
                tradesList.push({
                    date: new Date(c.timestamp).toISOString(),
                    symbol: SYMBOL,
                    side: decision.direction,
                    action: 'OPEN',
                    qty: pos.totalQuantity,
                    price: pos.entryPrice,
                    sl: pos.stopLoss,
                    tp1: pos.tp1Price,
                    tp2: pos.tp2Price,
                    tp3: pos.tp3Price,
                    balance: broker.getAvailableBalanceUsd(),
                    reasoning: decision.arbiterReasoning
                });
            }
        } else if (decision.outcome === 'REJECT') {
             // console.log(`[Backtest] Rejected at ${new Date(c.timestamp).toISOString()}: ${decision.arbiterReasoning}`);
        }
    }
    
    console.log('--- LOOP FINISHED ---');
    
    // Close any remaining open positions
    await pm.forceCloseAll('backtest_end');
    console.log('--- FORCED CLOSE DONE ---');

    // ── Statistics ────────────────────────────────────────────────────────────
    console.log(`[Backtest] Calculating stats for ${tradesList.length} events...`);
    const closes = tradesList.filter(t => t.action.startsWith('CLOSE'));
    const opens = tradesList.filter(t => t.action === 'OPEN');
    
    const wins = closes.filter(t => t.pnlUSDT > 0);
    const losses = closes.filter(t => t.pnlUSDT <= 0);
    
    const winRate = closes.length ? round((wins.length / closes.length) * 100, 1) : 0;
    const totalPnL = round(closes.reduce((s, t) => s + t.pnlUSDT, 0), 2);
    
    const finalBalance = broker.getAvailableBalanceUsd();

    const report = {
        symbol: SYMBOL, tf: TF,
        from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(),
        totalCandles: candles.length,
        totalOpens: opens.length,
        totalCloses: closes.length,
        wins: wins.length, losses: losses.length,
        winRate: `${winRate}%`,
        totalPnL: `$${totalPnL}`,
        finalBalance: `$${round(finalBalance, 2)}`,
        returnPct: `${round(pct(finalBalance, BALANCE), 2)}%`,
        slAtr: SL_ATR, tp1Atr: TP1_ATR, tp2Atr: TP2_ATR, tp3Atr: TP3_ATR
    };

    console.log('\n══════════════════════════════════════');
    console.log('  ADVANCED BACKTEST REPORT');
    console.log('══════════════════════════════════════');
    console.table(report);
    console.log('\n--- FINAL JSON REPORT ---');
    console.log(JSON.stringify(report, null, 2));
    fs.writeFileSync('backtest_report.json', JSON.stringify(report, null, 2));
    console.log('Report saved to backtest_report.json');
    console.log('--- BACKTEST COMPLETE ---');
}

main().catch(err => {
    console.error('[Backtest] failed', err);
    process.exit(1);
});
