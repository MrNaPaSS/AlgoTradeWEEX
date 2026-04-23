require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function testExecution() {
    logger.info('=============================================');
    logger.info('   ALGO TRADE PRO: REAL EXECUTION TEST      ');
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
        logger.info(`[Test] Fetching current price for ${SYMBOL} using 1m kline...`);
        const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
        const price = candles[0]?.close;
        
        if (!price || isNaN(price)) {
            throw new Error(`Could not fetch valid price for ${SYMBOL}. Received: ${JSON.stringify(candles)}`);
        }
        
        logger.info(`[Test] Current price: ${price}. Opening MINIMAL LONG (20 USDT notional, 10x leverage)...`);
        
        const notional = 20;
        const leverage = 10;
        const quantity = parseFloat((notional / price).toFixed(3));
        
        const sl = parseFloat((price * 0.99).toFixed(2));
        const tp1 = parseFloat((price * 1.01).toFixed(2));
        const tp2 = parseFloat((price * 1.02).toFixed(2));
        const tp3 = parseFloat((price * 1.03).toFixed(2));

        const sizing = {
            quantity,
            leverage,
            entryPrice: price,
            stopLoss: sl,
            tp1Price: tp1,
            tp2Price: tp2,
            tp3Price: tp3
        };

        const fill = await pm.open({
            symbol: SYMBOL,
            direction: 'LONG',
            markPrice: price,
            sizing,
            decisionId: 'test_decision'
        });
        
        if (!fill) {
            throw new Error('Position was not opened. Check logs above.');
        }

        const tpLadder = await broker.placeTpLadder({
            symbol: SYMBOL,
            side: 'long',
            totalQty: quantity,
            tp1Price: tp1,
            tp2Price: tp2,
            tp3Price: tp3,
            tp1Pct: 0.5,
            tp2Pct: 0.3,
            tp3Pct: 0.2
        });

        logger.info('✅ SUCCESS: Position opened on WEEX!');
        logger.info(`   Order ID: ${fill.orderId}`);
        logger.info(`   SL: ${sl}, TP1: ${tp1}`);
        logger.info(`   Position will remain OPEN for manual inspection.`);
        logger.info('   Please check the "Position TP/SL" column in the terminal.');

    } catch (err) {
        logger.error(`❌ ERROR: ${err.message}`);
    } finally {
        logger.info('\n=============================================');
        logger.info('   TEST COMPLETED');
        logger.info('=============================================');
    }
}

testExecution().catch(err => {
    console.error('Fatal error:', err);
});
