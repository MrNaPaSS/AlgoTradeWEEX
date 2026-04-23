#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const PARAMS = '--tf 1h --from 2026-03-10 --slAtr 5 --tp1Atr 2 --tp2Atr 3 --tp3Atr 6 --risk 5 --leverage 10 --balance 20000';

async function main() {
    const allResults = [];
    console.log('══════════════════════════════════════════════════════════════');
    console.log('  MULTI-SYMBOL BACKTEST VALIDATION (80%+ Goal)');
    console.log('══════════════════════════════════════════════════════════════\n');

    for (const symbol of SYMBOLS) {
        console.log(`[Multi] Testing ${symbol}...`);
        try {
            // Run the advanced backtest for this symbol
            execSync(`node scripts/advanced_backtest.js --symbol ${symbol} ${PARAMS}`, { stdio: 'inherit' });
            
            // Read the generated report
            if (fs.existsSync('backtest_report.json')) {
                const report = JSON.parse(fs.readFileSync('backtest_report.json', 'utf8'));
                allResults.push(report);
            }
        } catch (err) {
            console.error(`[Multi] Failed to test ${symbol}: ${err.message}`);
        }
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log('  FINAL MULTI-SYMBOL REPORT');
    console.log('══════════════════════════════════════════════════════════════');
    
    const summary = allResults.map(r => ({
        Symbol: r.symbol,
        Winrate: r.winRate,
        PnL: r.totalPnL,
        Return: r.returnPct,
        Trades: r.totalCloses,
        Candles: r.totalCandles
    }));

    console.table(summary);

    const avgWinrate = allResults.reduce((s, r) => s + parseFloat(r.winRate), 0) / allResults.length;
    const totalPnL = allResults.reduce((s, r) => s + parseFloat(r.totalPnL.replace('$', '')), 0);

    console.log(`\nAverage Winrate: ${avgWinrate.toFixed(1)}%`);
    console.log(`Total Aggregate PnL: $${totalPnL.toFixed(2)}`);
    
    fs.writeFileSync('multi_backtest_results.json', JSON.stringify(allResults, null, 2));
    console.log('Detailed results saved to multi_backtest_results.json');
}

main().catch(console.error);
