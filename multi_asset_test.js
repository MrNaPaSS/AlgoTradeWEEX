const axios = require('axios');
const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');
const config = require('./src/config/config');

const URL = 'http://localhost:3000/webhook';
const SECRET = 'super_secret_webhook_password_123';
const client = new WeexFuturesClient(config.weex);

async function sendSignal(symbol, action) {
    console.log(`>>> Sending ${action} signal for ${symbol}...`);
    try {
        // Get current price to satisfy validation
        const ticker = await client.getTicker(symbol);
        const price = Number(ticker.lastPrice || ticker.close || ticker.last);
        
        const res = await axios.post(URL, {
            secret: SECRET,
            symbol: symbol,
            action: action,
            strategy: 'Sniper',
            tf: '1m', // Bot expects 'tf'
            price: price, // Bot expects 'price'
            signalType: action === 'long' ? 'BM_LONG' : 'BM_SHORT'
        });
        console.log(`   Price: ${price} | Response: ${JSON.stringify(res.data)}`);
    } catch (e) {
        console.error(`   Error: ${e.message} - ${JSON.stringify(e.response?.data)}`);
    }
}

async function run() {
    console.log('--- STARTING MULTI-ASSET PRECISION TEST ---');
    
    await sendSignal('ETHUSDT', 'short');
    await new Promise(r => setTimeout(r, 2000));
    
    await sendSignal('SOLUSDT', 'short');
    await new Promise(r => setTimeout(r, 2000));

    await sendSignal('XAUTUSDT', 'short');
    
    console.log('\n--- MONITORING LOGS (15s) ---');
    await new Promise(r => setTimeout(r, 15000));
    console.log('\n--- DONE ---');
}

run();
