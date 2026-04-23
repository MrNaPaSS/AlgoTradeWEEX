#!/usr/bin/env node
/**
 * scripts/backtest.js — Offline strategy backtester
 *
 * Usage:
 *   node scripts/backtest.js --symbol XAUTUSDT --tf 1h --from 2026-01-01 --to 2026-04-01
 *   node scripts/backtest.js --symbol BTCUSDT --tf 1h --from 2026-01-01
 *
 * Output: JSON report + CSV to ./data/backtest_<symbol>_<tf>_<timestamp>.csv
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { chandelierExit }    = require('../src/indicators/chandelierExit');
const { blackMirrorScore }  = require('../src/indicators/blackMirrorScore');
const logger = require('../src/utils/logger');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc[val.slice(2)] = arr[i + 1];
    return acc;
}, {});

const SYMBOL    = (args.symbol || 'BTCUSDT').toUpperCase();
const TF        = args.tf     || '1h';
const FROM      = args.from   ? new Date(args.from).getTime() : Date.now() - 90 * 86400_000;
const TO        = args.to     ? new Date(args.to).getTime()   : Date.now();
const BM_THRESH = parseInt(args.bmThreshold || '3', 10);
const LEVERAGE  = parseFloat(args.leverage  || '5');
const RISK_PCT  = parseFloat(args.risk      || '1');   // % of balance per trade
const BALANCE   = parseFloat(args.balance   || '10000');

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(a, b) { return ((a - b) / b) * 100; }
function round(n, d = 2) { return Math.round(n * 10 ** d) / 10 ** d; }

async function fetchAllCandles(client, symbol, tf) {
    const allCandles = [];
    const LIMIT = 1000;
    let endTime = TO;

    while (true) {
        const batch = await client.getCandles({ symbol, tf, limit: LIMIT, endTime });
        if (!batch || batch.length === 0) break;
        allCandles.unshift(...batch);
        const earliest = batch[0].timestamp;
        if (earliest <= FROM) break;
        endTime = earliest - 1;
        await new Promise(r => setTimeout(r, 200)); // rate limit
    }

    return allCandles
        .filter(c => c.timestamp >= FROM && c.timestamp <= TO)
        .sort((a, b) => a.timestamp - b.timestamp);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    logger.info(`[Backtest] ${SYMBOL} ${TF} | ${new Date(FROM).toISOString()} → ${new Date(TO).toISOString()}`);
    logger.info(`[Backtest] BM threshold: ${BM_THRESH} | Leverage: ${LEVERAGE}x | Risk: ${RISK_PCT}%`);

    const client = new WeexFuturesClient({
        apiKey:     process.env.WEEX_API_KEY     || '',
        secretKey:  process.env.WEEX_SECRET_KEY  || '',
        passphrase: process.env.WEEX_PASSPHRASE  || ''
    });

    logger.info('[Backtest] Fetching candles...');
    const candles = await fetchAllCandles(client, SYMBOL, TF);
    logger.info(`[Backtest] Got ${candles.length} candles`);

    if (candles.length < 50) {
        logger.error('[Backtest] Not enough candles to run backtest (need ≥ 50)');
        process.exit(1);
    }

    // ── Run indicators ────────────────────────────────────────────────────────
    const ceResult  = chandelierExit(candles, { length: 22, mult: 3.0 });
    const bmResult  = blackMirrorScore(candles, { threshold: BM_THRESH });

    // ── Simulate trades ───────────────────────────────────────────────────────
    const trades = [];
    let balance  = BALANCE;
    let position = null; // { side, entryPrice, qty, sl, entryIdx }

    const COMMISSION = 0.0004; // 0.04% taker

    for (let i = 23; i < candles.length; i++) {
        const c    = candles[i];
        const buy  = ceResult.buySignal[i];
        const sell = ceResult.sellSignal[i];
        const bmL  = bmResult.longSignal[i];
        const bmS  = bmResult.shortSignal[i];
        const ls   = ceResult.longStop[i];
        const ss   = ceResult.shortStop[i];

        // Check stop loss hit (using low/high of bar)
        if (position) {
            const slHit = position.side === 'LONG'
                ? c.low  <= position.sl
                : c.high >= position.sl;

            if (slHit || (position.side === 'LONG' && sell) || (position.side === 'SHORT' && buy)) {
                const exitPrice = slHit ? position.sl : c.close;
                const pnlPct    = position.side === 'LONG'
                    ? pct(exitPrice, position.entryPrice)
                    : pct(position.entryPrice, exitPrice);
                const pnlUSDT   = position.qty * (exitPrice - position.entryPrice) * (position.side === 'LONG' ? 1 : -1) * LEVERAGE;
                const commission = position.qty * exitPrice * COMMISSION;
                balance += pnlUSDT - commission;

                trades.push({
                    idx: i,
                    date: new Date(c.timestamp).toISOString(),
                    side: position.side,
                    entry: position.entryPrice,
                    exit: exitPrice,
                    sl: position.sl,
                    pnlPct: round(pnlPct, 4),
                    pnlUSDT: round(pnlUSDT, 2),
                    balance: round(balance, 2),
                    reason: slHit ? 'SL' : 'REVERSAL'
                });
                position = null;
            }
        }

        // Open new position
        if (!position) {
            if (buy && bmL && Number.isFinite(ls)) {
                const risk   = balance * (RISK_PCT / 100);
                const slDist = Math.abs(c.close - ls);
                const qty    = slDist > 0 ? risk / slDist : 0;
                if (qty > 0) {
                    const commission = qty * c.close * COMMISSION;
                    balance -= commission;
                    position = { side: 'LONG', entryPrice: c.close, qty, sl: ls, entryIdx: i };
                }
            } else if (sell && bmS && Number.isFinite(ss)) {
                const risk   = balance * (RISK_PCT / 100);
                const slDist = Math.abs(ss - c.close);
                const qty    = slDist > 0 ? risk / slDist : 0;
                if (qty > 0) {
                    const commission = qty * c.close * COMMISSION;
                    balance -= commission;
                    position = { side: 'SHORT', entryPrice: c.close, qty, sl: ss, entryIdx: i };
                }
            }
        }
    }

    // ── Statistics ────────────────────────────────────────────────────────────
    const wins      = trades.filter(t => t.pnlUSDT > 0);
    const losses    = trades.filter(t => t.pnlUSDT <= 0);
    const winRate   = trades.length ? round((wins.length / trades.length) * 100, 1) : 0;
    const totalPnL  = round(trades.reduce((s, t) => s + t.pnlUSDT, 0), 2);
    const avgWin    = wins.length   ? round(wins.reduce((s, t)   => s + t.pnlUSDT, 0) / wins.length,   2) : 0;
    const avgLoss   = losses.length ? round(losses.reduce((s, t) => s + t.pnlUSDT, 0) / losses.length, 2) : 0;
    const profitFactor = losses.length && avgLoss < 0 ? round(-avgWin * wins.length / (avgLoss * losses.length), 2) : '∞';

    // Max drawdown
    let peak = BALANCE, maxDD = 0, runBal = BALANCE;
    for (const t of trades) {
        runBal += t.pnlUSDT;
        if (runBal > peak) peak = runBal;
        const dd = peak - runBal;
        if (dd > maxDD) maxDD = dd;
    }
    const maxDDPct = round((maxDD / BALANCE) * 100, 2);

    // Sharpe (simplified, daily returns assumed)
    const returns = trades.map(t => t.pnlUSDT / BALANCE);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
    const stdDev = Math.sqrt(returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / (returns.length || 1));
    const sharpe = stdDev > 0 ? round(avgReturn / stdDev * Math.sqrt(252), 2) : 0;

    const report = {
        symbol: SYMBOL, tf: TF,
        from: new Date(FROM).toISOString(), to: new Date(TO).toISOString(),
        totalCandles: candles.length,
        totalTrades: trades.length,
        wins: wins.length, losses: losses.length,
        winRate: `${winRate}%`,
        totalPnL: `$${totalPnL}`,
        finalBalance: `$${round(balance, 2)}`,
        returnPct: `${round(pct(balance, BALANCE), 2)}%`,
        avgWin: `$${avgWin}`, avgLoss: `$${avgLoss}`,
        profitFactor,
        maxDrawdown: `$${round(maxDD, 2)} (${maxDDPct}%)`,
        sharpeRatio: sharpe,
        bmThreshold: BM_THRESH,
        leverage: LEVERAGE
    };

    console.log('\n══════════════════════════════════════');
    console.log('  BACKTEST REPORT');
    console.log('══════════════════════════════════════');
    console.table(report);

    // ── Save CSV ──────────────────────────────────────────────────────────────
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const ts = Date.now();
    const csvPath = path.join(dataDir, `backtest_${SYMBOL}_${TF}_${ts}.csv`);
    const jsonPath = path.join(dataDir, `backtest_${SYMBOL}_${TF}_${ts}.json`);

    const header = 'idx,date,side,entry,exit,sl,pnlPct,pnlUSDT,balance,reason\n';
    const rows = trades.map(t =>
        `${t.idx},${t.date},${t.side},${t.entry},${t.exit},${t.sl},${t.pnlPct},${t.pnlUSDT},${t.balance},${t.reason}`
    ).join('\n');
    fs.writeFileSync(csvPath, header + rows);
    fs.writeFileSync(jsonPath, JSON.stringify({ report, trades }, null, 2));

    logger.info(`[Backtest] CSV  → ${csvPath}`);
    logger.info(`[Backtest] JSON → ${jsonPath}`);
}

main().catch(err => {
    logger.error('[Backtest] failed', { message: err.message, stack: err.stack });
    process.exit(1);
});
