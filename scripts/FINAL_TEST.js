require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function finalTest() {
    const db = new Database();
    await db.init();

    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });
    const broker = new LiveBroker({ client });

    const SYMBOL = 'ETHUSDT';
    
    // 1. Force cleanup and new position entry
    logger.info('--- STEP 1: OPENING POSITION ---');
    const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
    const entryPrice = candles[0]?.close;
    
    const pm = new PositionManager({
        database: db,
        broker: broker,
        minNotionalUsd: 5
    });

    const pos = await pm.open({
        symbol: SYMBOL,
        direction: 'LONG',
        markPrice: entryPrice,
        sizing: {
            quantity: 0.01,
            leverage: 10,
            entryPrice,
            stopLoss: entryPrice - 20,
            takeProfits: [{ price: entryPrice + 10, pct: 50 }]
        },
        decisionId: 'final_test'
    });

    if (!pos) throw new Error('Open failed');
    logger.info('✅ Position opened at ' + pos.entryPrice);

    // 2. FORCE TP1 HIT IN DB
    logger.info('--- STEP 2: FORCING TP1 HIT ---');
    db.debugUpdatePosition(SYMBOL, { 
        tp1_price: 1000,
        tp1_order_id: null,
        tp2_order_id: null,
        tp3_order_id: null
    });
    
    // Refresh PM memory to see the DB changes
    pm._hydrate();

    // 3. TRIGGER EVALUATION
    logger.info('--- STEP 3: TRIGGERING EVALUATION ---');
    await pm.onMarkPrice(SYMBOL, entryPrice);

    logger.info('--- ALL DONE ---');
    logger.info('Check WEEX: 50% should be closed, and SL moved to ' + entryPrice);
    
    // Force save
    await db.close();
}

finalTest().catch(console.error);
