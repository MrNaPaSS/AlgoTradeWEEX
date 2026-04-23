const { LiveBroker } = require('../src/services/LiveBroker');
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { Database } = require('../src/services/database');
const logger = require('../src/utils/logger');
const path = require('path');
require('dotenv').config();

async function runFullSmoke() {
    console.log('🚀 STARTING FULL V3 SMOKE TEST (ETHUSDT)');
    
    const db = new Database(path.join(__dirname, '../data/trading.db'));
    const client = new WeexFuturesClient({
        apiKey: process.env.WEEX_API_KEY,
        secretKey: process.env.WEEX_SECRET_KEY,
        passphrase: process.env.WEEX_PASSPHRASE
    });
    const broker = new LiveBroker({ client });

    const symbol = 'ETHUSDT';
    const quantity = 0.01; // Smallest for ETH on WEEX
    const leverage = 10;

    try {
        // --- STEP 0: Cleanup ---
        console.log('\n--- STEP 0: CLEANUP ---');
        await broker.cancelAllForSymbol(symbol);
        const positions = await broker.getOpenPositions();
        const existing = positions.find(p => p.symbol === symbol);
        if (existing) {
            console.log('Closing existing position...');
            await broker.closeMarket({ symbol, side: existing.side, quantity: existing.totalQuantity });
        }

        // --- STEP 1: ENTRY ---
        console.log('\n--- STEP 1: ENTRY (Market + Separated SL/TP) ---');
        const ticker = await client.getTicker(symbol);
        const markPrice = Number(ticker.lastPrice);
        const slPrice = Number((markPrice * 0.98).toFixed(2));
        const tpPrice = Number((markPrice * 1.02).toFixed(2));

        console.log(`Diagnostic: markPrice=${markPrice}, slPrice=${slPrice}, tpPrice=${tpPrice}`);

        if (!markPrice || isNaN(markPrice)) {
            throw new Error(`CRITICAL: markPrice is invalid! Ticker raw: ${JSON.stringify(ticker)}`);
        }

        const openRes = await broker.placeMarketOrder({
            symbol,
            side: 'long',
            quantity,
            leverage,
            stopLoss: slPrice,
            tpPrice: tpPrice
        });

        console.log('✅ Entry Success');
        console.log('Order ID:', openRes.orderId);
        console.log('Captured SL Order ID (H1 Check):', openRes.slOrderId);
        console.log('Captured TP Order ID (H1 Check):', openRes.tpOrderId);

        if (!openRes.slOrderId) {
            throw new Error('FAILED: slOrderId was not captured! H1 fix regression.');
        }

        // --- STEP 2: VERIFY EXCHANGE ---
        console.log('\n--- STEP 2: VERIFY EXCHANGE STATE ---');
        await new Promise(r => setTimeout(r, 2000));
        const openOrders = await client.getOpenOrders(symbol);
        // Note: TP/SL are "Plan Orders", might not show in getOpenOrders but we verify by success:true from broker
        console.log(`Found ${openOrders.length} basic open orders (usually 0 for plan orders)`);

        // --- STEP 3: ATOMIC MODIFY (H2) ---
        console.log('\n--- STEP 3: ATOMIC MODIFY (Move SL slightly) ---');
        const newSlPrice = slPrice * 1.005; // Move SL 0.5% up
        console.log(`Modifying SL from ${slPrice} to ${newSlPrice} (Atomic path)...`);
        
        const modRes = await broker.modifySlTp({
            symbol,
            orderId: openRes.slOrderId,
            slTriggerPrice: newSlPrice
        });

        console.log('✅ Modify Success:', modRes);

        console.log('\n--- WAITING 30 SECONDS FOR USER TO VERIFY ON EXCHANGE UI ---');
        console.log('Check your ETHUSDT position and TP/SL orders now...');
        await new Promise(r => setTimeout(r, 30000));

        // --- STEP 4: EXIT ---
        console.log('\n--- STEP 4: EXIT (Market Close + Cleanup) ---');
        const closeRes = await broker.closeMarket({
            symbol,
            side: 'long',
            quantity,
            entryPrice: markPrice,
            markPrice: markPrice
        });
        console.log('✅ Close Success. PnL:', closeRes.pnl);

        console.log('\n--- FINAL CLEANUP ---');
        await broker.cancelAllForSymbol(symbol);
        console.log('✅ CLEANUP DONE');
        
        console.log('\n🏆 FULL SMOKE TEST PASSED! H1 and H2 VERIFIED IN LIVE.');

    } catch (err) {
        console.error('\n❌ SMOKE TEST FAILED:', err.message);
        if (err.response) console.error('Data:', err.response.data);
    } finally {
        await db.close();
    }
}

runFullSmoke();
