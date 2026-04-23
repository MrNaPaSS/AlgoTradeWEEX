require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function forceBreakeven() {
    const db = new Database();
    await db.init();
    
    // 1. Force TP1 to be very low in DB and clear TP order IDs to prevent deferring
    db.debugUpdatePosition('ETHUSDT', { 
        tp1_price: 1000,
        tp1_order_id: null,
        tp2_order_id: null,
        tp3_order_id: null,
        sl_order_id: null,
        sl_moved_to_breakeven: 0
    });
    logger.info('✅ Database UPDATED: Ready for ForceBE');

    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    const broker = new LiveBroker({ client });
    
    const pm = new PositionManager({
        database: db,
        broker: broker,
        minNotionalUsd: 5
    });

    // 2. Run check one time
    const candles = await client.getCandles({ symbol: 'ETHUSDT', tf: '1m', limit: 1 });
    const markPrice = candles[0]?.close;
    
    logger.info(`[ForceBE] Current Price: ${markPrice}. Triggering evaluation...`);
    await pm.onMarkPrice('ETHUSDT', markPrice);
    
    logger.info('--- DONE ---');
    logger.info('Check your terminal: Stop Loss should have moved to Entry Price.');
}

forceBreakeven().catch(console.error);
