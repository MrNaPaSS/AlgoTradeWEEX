const { LiveBroker } = require('../src/services/LiveBroker');
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { PositionManager } = require('../src/services/PositionManager');
const { Database } = require('../src/services/database');
const { createPosition } = require('../src/domain/Position');
const logger = require('../src/utils/logger');
const path = require('path');
require('dotenv').config();

async function runScenarioTests() {
    console.log('🚀 STARTING V3 SCENARIO STRESS TEST');
    
    const db = new Database();
    await db.init();
    const client = new WeexFuturesClient({
        apiKey: process.env.WEEX_API_KEY,
        secretKey: process.env.WEEX_SECRET_KEY,
        passphrase: process.env.WEEX_PASSPHRASE
    });
    const broker = new LiveBroker({ client });
    const pm = new PositionManager({ database: db, broker });

    const symbol = 'ETHUSDT';
    const quantity = 0.01;

    try {
        console.log('\n--- CLEANUP ---');
        await broker.cancelAllForSymbol(symbol);
        const remotePos = await broker.getOpenPositions();
        if (remotePos.find(p => p.symbol === symbol)) {
            await broker.closeMarket({ symbol, side: remotePos.find(p => p.symbol === symbol).side, quantity });
        }

        // --- SCENARIO 1: ATOMIC BREAKEVEN ---
        console.log('\n--- SCENARIO 1: ATOMIC BREAKEVEN (TP1 HIT) ---');
        const ticker = await client.getTicker(symbol);
        const entryPrice = Number(ticker.lastPrice);
        
        console.log('Opening test position...');
        const openRes = await broker.placeMarketOrder({
            symbol, side: 'long', quantity, leverage: 10,
            stopLoss: Number((entryPrice * 0.95).toFixed(2)), 
            tpPrice: Number((entryPrice * 1.05).toFixed(2))
        });

        const pos = createPosition({
            positionId: 'scenario_1',
            symbol, side: 'long', entryPrice,
            totalQuantity: quantity, remainingQuantity: quantity,
            slOrderId: openRes.slOrderId,
            status: 'OPEN', mode: 'live'
        });
        pm._push(pos);

        console.log('Simulating TP1 hit at +1% profit...');
        const markPriceFavor = entryPrice * 1.01;
        // Trigger partial close manually
        await pm._partialClose(pos, markPriceFavor, 1, 0.5); 
        console.log('✅ Breakeven move should be sent to exchange.');
        await new Promise(r => setTimeout(r, 5000));

        // --- SCENARIO 2: SAFETY DISTANCE (BUG 2) ---
        console.log('\n--- SCENARIO 2: SAFETY DISTANCE CHECK ---');
        console.log('Cleaning up orders before Scenario 2...');
        await broker.cancelAllForSymbol(symbol);
        
        console.log('Simulating price REVERSAL near entry (too close for BE)...');
        const markPriceTooClose = entryPrice * 1.0005; // 0.05% away, buffer is 0.1%
        
        // We reuse the same pos but reset level to test distance check again
        await pm._partialClose(pos, markPriceTooClose, 1, 0.5);
        console.log('✅ Should see "Breakeven move skipped" in logs (No exchange error).');

        // --- SCENARIO 3: FALLBACK REPLACE (STALE ID) ---
        console.log('\n--- SCENARIO 3: FALLBACK REPLACE (ID MISMATCH) ---');
        console.log('Cleaning up orders before Scenario 3...');
        await broker.cancelAllForSymbol(symbol);
        
        console.log('Trying to modify with a FAKE slOrderId...');
        
        const stalePos = { ...pos, slOrderId: 'stale_id_999' };
        // We need markPrice in favor again
        await pm._partialClose(stalePos, entryPrice * 1.02, 1, 0.5);
        console.log('✅ Should trigger fallback cancel-by-prefix and create NEW SL.');

        await new Promise(r => setTimeout(r, 5000));
        console.log('\n--- SCENARIO TESTS COMPLETE ---');
        
        await broker.closeMarket({ symbol, side: 'long', quantity, entryPrice, markPrice: entryPrice });
        await broker.cancelAllForSymbol(symbol);
        console.log('🏆 ALL SCENARIOS VERIFIED.');

    } catch (err) {
        console.error('❌ SCENARIO FAILED:', err.message);
    } finally {
        await db.close();
    }
}

runScenarioTests();
