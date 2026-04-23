require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const config = require('../src/config/config');

async function fullCleanup() {
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    const SYMBOL = 'ETHUSDT';
    console.log(`--- FULL CLEANUP FOR ${SYMBOL} ---`);

    try {
        // 1. Cancel all normal orders
        console.log('Cancelling normal orders...');
        await client.cancelAllForSymbol(SYMBOL);
        
        // 2. Cancel all plan orders (if we had a specific endpoint, we'd use it)
        // On WEEX V3, plan orders often need to be cancelled via their specific ID or a general cancel
        console.log('Fetching open orders to find remaining Plan Orders...');
        const orders = await client.getOpenOrders(SYMBOL);
        for (const o of orders) {
            console.log(`Found order ${o.orderId} (${o.type}). Cancelling...`);
            await client.cancelOrder({ symbol: SYMBOL, orderId: o.orderId });
        }
        
        console.log('--- CLEANUP DONE ---');
        console.log('You should be able to close the position manually now.');
    } catch (err) {
        console.error('Cleanup failed:', err.message);
    }
}

fullCleanup().catch(console.error);
