require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const config = require('../src/config/config');

async function check() {
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    console.log('--- OPEN ORDERS (Limit) ---');
    const limitOrders = await client.getOpenOrders('ETHUSDT');
    console.log(JSON.stringify(limitOrders, null, 2));

    console.log('\n--- POSITIONS ---');
    const positions = await client.getPositions();
    console.log(JSON.stringify(positions.filter(p => p.symbol === 'ETHUSDT'), null, 2));
}

check().catch(console.error);
