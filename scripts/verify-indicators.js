#!/usr/bin/env node
/**
 * scripts/verify-indicators.js — Compare local indicator calculations vs TradingView
 *
 * Usage:
 *   node scripts/verify-indicators.js --symbol BTCUSDT --tf 1h
 *   node scripts/verify-indicators.js --symbol XAUTUSDT --tf 4h --limit 50
 *
 * Fetches real OHLCV from WEEX, computes all indicators,
 * and outputs the last N rows as CSV for manual comparison with TradingView.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { chandelierExit }    = require('../src/indicators/chandelierExit');
const { blackMirrorScore }  = require('../src/indicators/blackMirrorScore');
const { ema }               = require('../src/indicators/ema');
const { rsi }               = require('../src/indicators/rsi');
const { atr }               = require('../src/indicators/atr');
const { macd }              = require('../src/indicators/macd');
const logger = require('../src/utils/logger');

const args = process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith('--')) acc[val.slice(2)] = arr[i + 1];
    return acc;
}, {});

const SYMBOL = (args.symbol || 'BTCUSDT').toUpperCase();
const TF     = args.tf     || '1h';
const LIMIT  = parseInt(args.limit || '200', 10);
const ROWS   = parseInt(args.rows  || '20',  10);  // how many recent rows to output

async function main() {
    logger.info(`[Verify] Fetching ${LIMIT} candles for ${SYMBOL} ${TF}...`);

    const client = new WeexFuturesClient({
        apiKey:     process.env.WEEX_API_KEY    || '',
        secretKey:  process.env.WEEX_SECRET_KEY || '',
        passphrase: process.env.WEEX_PASSPHRASE || ''
    });

    const candles = await client.getCandles({ symbol: SYMBOL, tf: TF, limit: LIMIT });
    logger.info(`[Verify] Got ${candles.length} candles`);

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const ema8   = ema(closes, 8);
    const ema21  = ema(closes, 21);
    const ema50  = ema(closes, 50);
    const rsi14  = rsi(closes, 14);
    const atr22  = atr(candles, 22);
    const macdR  = macd(closes);
    const ce     = chandelierExit(candles, { length: 22, mult: 3.0 });
    const bm     = blackMirrorScore(candles);

    const n     = candles.length;
    const start = Math.max(0, n - ROWS);

    const rows = [];
    for (let i = start; i < n; i++) {
        rows.push({
            date:       new Date(candles[i].timestamp).toISOString(),
            close:      candles[i].close.toFixed(4),
            ema8:       (ema8[i]  ?? '').toString().slice(0, 10),
            ema21:      (ema21[i] ?? '').toString().slice(0, 10),
            ema50:      (ema50[i] ?? '').toString().slice(0, 10),
            rsi14:      (rsi14[i] ?? '').toString().slice(0, 7),
            atr22:      (atr22[i] ?? '').toString().slice(0, 10),
            macdLine:   (macdR.macdLine?.[i] ?? '').toString().slice(0, 10),
            macdSignal: (macdR.signalLine?.[i] ?? '').toString().slice(0, 10),
            longStop:   (ce.longStop[i]  ?? '').toString().slice(0, 10),
            shortStop:  (ce.shortStop[i] ?? '').toString().slice(0, 10),
            ceDir:      ce.direction[i] ?? '',
            ceBuy:      ce.buySignal[i]  ? '✓BUY'  : '',
            ceSell:     ce.sellSignal[i] ? '✓SELL' : '',
            bmLong:     bm.scoreLong[i]  ?? '',
            bmShort:    bm.scoreShort[i] ?? '',
            bmLsig:     bm.longSignal[i]  ? '✓' : '',
            bmSsig:     bm.shortSignal[i] ? '✓' : ''
        });
    }

    // Print table
    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(`  INDICATOR VERIFICATION — ${SYMBOL} ${TF} (last ${ROWS} bars)`);
    console.log('══════════════════════════════════════════════════════════════');
    console.table(rows);

    // Save CSV
    const dataDir  = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    const csvPath  = path.join(dataDir, `verify_${SYMBOL}_${TF}.csv`);
    const header   = Object.keys(rows[0] || {}).join(',') + '\n';
    const csvRows  = rows.map(r => Object.values(r).join(',')).join('\n');
    fs.writeFileSync(csvPath, header + csvRows);
    logger.info(`[Verify] Saved CSV → ${csvPath}`);
    logger.info('[Verify] Compare values with TradingView chart (tolerance ±0.01%)');
}

main().catch(err => {
    logger.error('[Verify] failed', { message: err.message });
    process.exit(1);
});
