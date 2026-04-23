require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const config = require('../src/config/config');

async function cleanup() {
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    console.log('Cancelling all orders for ETHUSDT...');
    await client.cancelAllForSymbol('ETHUSDT');
    
    // Also try to cancel specific IDs if they remain
    const orders = await client.getOpenOrders('ETHUSDT');
    for (const o of orders) {
        console.log(`Cancelling order ${o.orderId}...`);
        await client.cancelOrder({ symbol: 'ETHUSDT', orderId: o.orderId });
    }
    
    console.log('Done.');
}

cleanup().catch(console.error);
