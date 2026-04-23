require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function testLiveBreakeven() {
    logger.info('=============================================');
    logger.info('   LIVE TEST: REAL-TIME BREAKEVEN MOVE      ');
    logger.info('   Target: ETHUSDT (TP1 is very close)      ');
    logger.info('=============================================');

    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    const broker = new LiveBroker({ client });
    const db = new Database();
    await db.init();
    
    const pm = new PositionManager({
        database: db,
        broker: broker,
        minNotionalUsd: 5
    });

    const SYMBOL = 'ETHUSDT';
    
    try {
        // 1. Fetch current price
        const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
        const entryPrice = candles[0]?.close;
        logger.info(`[Test] Entry Price: ${entryPrice}`);

        // Set TP1 at valid distance
        const tp1Price = entryPrice + 5.0; 
        const slPrice = entryPrice - 20.0;

        logger.info(`[Test] Setting TP1 at ${tp1Price} (+5 USD)`);
        logger.info(`[Test] Setting initial SL at ${slPrice}`);

        const sizing = {
            quantity: 0.01, // Smallest possible for ETH
            leverage: 10,
            entryPrice,
            stopLoss: slPrice,
            takeProfits: [
                { price: tp1Price, pct: 50 } // We only use 1 TP for this test
            ]
        };

        // Open position (without ladder to ensure local bot handling for faster response)
        let fill = await pm.open({
            symbol: SYMBOL,
            direction: 'LONG',
            markPrice: entryPrice,
            sizing,
            decisionId: 'live_be_test'
        });

        if (!fill) {
            // Check if we have an existing one to monitor
            const existing = pm.getOpen().find(p => p.symbol === SYMBOL);
            if (existing) {
                logger.info('ℹ️ Existing position found. Monitoring it...');
                fill = existing;
            } else {
                throw new Error('Open failed and no existing position found');
            }
        } else {
            logger.info('✅ Step 1: Position opened. Monitoring for TP1 hit...');
        }

        // 2. Monitoring loop
        let seconds = 0;
        const MAX_SECONDS = 600; // 10 minutes

        while (seconds < MAX_SECONDS) {
            const currentCandles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
            const markPrice = currentCandles[0]?.close;
            
            process.stdout.write(`\r[Test] Price: ${markPrice} | Target: ${tp1Price} | Time: ${seconds}s   `);
            
            await pm.onMarkPrice(SYMBOL, markPrice);
            
            // Check if SL moved in DB
            const pos = (await db.getOpenPositions()).find(p => p.symbol === SYMBOL);
            if (pos && pos.slMovedToBreakeven) {
                logger.info('\n\n🚀 SUCCESS! TP1 Hit detected.');
                logger.info(`🚀 Bot closed 50% and moved SL to ${pos.stopLoss} (Entry: ${pos.entryPrice})`);
                break;
            }

            if (!pos || pos.status === 'CLOSED') {
                logger.info('\n[Test] Position closed (likely SL hit or manual).');
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            seconds++;
        }

        if (seconds >= MAX_SECONDS) {
            logger.warn('\n[Test] Timeout reached without TP1 hit.');
        }

    } catch (err) {
        logger.error(`\n❌ ERROR: ${err.message}`);
    } finally {
        logger.info('\n=============================================');
        logger.info('   TEST COMPLETED');
        logger.info('=============================================');
    }
}

testLiveBreakeven().catch(console.error);
