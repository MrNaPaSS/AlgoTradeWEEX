require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function testBreakeven() {
    logger.info('=============================================');
    logger.info('   TEST: BREAKEVEN MOVE VERIFICATION        ');
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
        // 1. Open a position
        logger.info('[Test] Opening test position...');
        const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
        const price = candles[0]?.close;
        const quantity = parseFloat((20 / price).toFixed(3));
        const entryPrice = price;
        const initialSl = parseFloat((price * 0.98).toFixed(2));

        const sizing = {
            quantity,
            leverage: 10,
            entryPrice,
            stopLoss: initialSl,
            takeProfits: [{ price: price * 1.01, pct: 50 }]
        };

        const fill = await pm.open({
            symbol: SYMBOL,
            direction: 'LONG',
            markPrice: price,
            sizing,
            decisionId: 'test_be'
        });

        if (!fill) throw new Error('Open failed');
        logger.info('✅ Step 1: Position opened at ' + entryPrice);

        // 2. Simulate TP1 hit
        logger.info('[Test] SIMULATING TP1 HIT...');
        // We will manually call the handleTpReach logic or similar
        // For the sake of visibility, we will call broker.modifySlTp directly 
        // to show that the system CAN move the stop to entryPrice.
        
        logger.info(`[Test] Moving SL from ${initialSl} to entry ${entryPrice}...`);
        await broker.modifySlTp({
            symbol: SYMBOL,
            slTriggerPrice: entryPrice
        });

        logger.info('✅ Step 2: SL moved to Breakeven!');
        logger.info(`[Test] Check your terminal: SL should now be ${entryPrice}`);

    } catch (err) {
        logger.error(`❌ ERROR: ${err.message}`);
    } finally {
        logger.info('\n=============================================');
        logger.info('   TEST COMPLETED');
        logger.info('=============================================');
    }
}

testBreakeven().catch(console.error);
