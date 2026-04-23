require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const config = require('../src/config/config');

async function grandTest() {
    const db = new Database();
    await db.init();

    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });
    const broker = new LiveBroker({ client });

    const SYMBOL = 'ETHUSDT';
    
    logger.info('=== GRAND TEST STARTING ===');

    // 1. Initial Cleanup
    logger.info('Step 0: Cleaning up everything...');
    db.debugUpdatePosition(SYMBOL, { status: 'CLOSED' });
    await client.cancelAllForSymbol(SYMBOL);
    const initialPos = await client.getPositions();
    const ethPos = initialPos.find(p => p.symbol === SYMBOL);
    if (ethPos) {
        await client.placeOrder({
            symbol: SYMBOL,
            side: ethPos.side === 'LONG' ? 'SELL' : 'BUY',
            positionSide: ethPos.side,
            orderType: 'MARKET',
            quantity: ethPos.size
        });
    }

    // 2. Open Position with 3 TPs
    logger.info('Step 1: Opening Position with 3 TPs...');
    const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
    const entryPrice = candles[0]?.close;
    
    const pm = new PositionManager({ database: db, broker: broker, minNotionalUsd: 5 });

    const pos = await pm.open({
        symbol: SYMBOL,
        direction: 'LONG',
        markPrice: entryPrice,
        sizing: {
            quantity: 0.02, // Larger qty to test multiple partials
            leverage: 10,
            entryPrice,
            stopLoss: entryPrice - 50,
            takeProfits: [
                { price: entryPrice + 10, pct: 50 },
                { price: entryPrice + 20, pct: 30 },
                { price: entryPrice + 30, pct: 20 }
            ]
        },
        decisionId: 'grand_test_' + Date.now()
    });

    if (!pos) throw new Error('Open failed');
    logger.info('✅ Position opened. Volume: 0.02 ETH. SL: ' + pos.stopLoss);

    // 3. Simulate TP1 Hit
    logger.info('Step 2: Simulating TP1 Hit (Breakeven Trigger)...');
    db.debugUpdatePosition(SYMBOL, { 
        tp1_price: 1000, // Force hit
        tp1_order_id: null,
        sl_order_id: null,
        sl_moved_to_breakeven: 0
    });
    pm._hydrate(); 
    await pm.onMarkPrice(SYMBOL, entryPrice);
    logger.info('✅ TP1 processed. Check WEEX: Qty should be 0.01, SL should be at ' + entryPrice);

    // 4. Simulate TP2 Hit
    logger.info('Step 3: Simulating TP2 Hit...');
    db.debugUpdatePosition(SYMBOL, { 
        tp2_price: 1000, // Force hit
        tp2_order_id: null
    });
    pm._hydrate();
    await pm.onMarkPrice(SYMBOL, entryPrice);
    logger.info('✅ TP2 processed. Check WEEX: Qty should be reduced further.');

    logger.info('=== GRAND TEST COMPLETED SUCCESSFULLY ===');
    await db.close();
}

grandTest().catch(console.error);
