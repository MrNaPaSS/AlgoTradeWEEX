require('dotenv').config();
const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');
const logger = require('./src/utils/logger');
const config = require('./src/config/config');

async function closeAll() {
    console.log('--- EMERGENCY CLEANUP AND CLOSE ALL ---');
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    try {
        const positions = await client.getPositions();
        console.log(`Found ${positions.length} positions.`);

        // 1. Cancel all plan orders for all involved symbols first
        const symbols = [...new Set(positions.map(p => p.symbol)), 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XAUTUSDT'];
        for (const sym of symbols) {
            console.log(`Canceling plan orders for ${sym}...`);
            await client.cancelAllForSymbol(sym);
        }

        // 2. Now close positions
        for (const pos of positions) {
            const size = pos.totalQuantity || pos.size || pos.remainingQuantity;
            if (parseFloat(size) <= 0) continue;

            console.log(`Closing ${pos.symbol} ${pos.side} size=${size}...`);
            
            const side = pos.side.toUpperCase() === 'SHORT' ? 'BUY' : 'SELL';
            const positionSide = pos.side.toUpperCase();

            const res = await client.placeOrder({
                symbol: pos.symbol,
                side: side,
                positionSide: positionSide,
                orderType: 'MARKET',
                quantity: size,
                reduceOnly: true
            });
            console.log(`Result for ${pos.symbol}:`, res);
        }
        
        console.log('--- CLEANUP COMPLETE ---');

    } catch (err) {
        console.error('FAILED TO CLEANUP:', err.message);
    }
}

closeAll();
