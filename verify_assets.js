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
            tf: '1m', 
            price: price,
            signalType: action === 'long' ? 'BM_LONG' : 'BM_SHORT'
        });
        console.log(`   Symbol: ${symbol} | Price: ${price} | Response: ${JSON.stringify(res.data)}`);
    } catch (e) {
        console.error(`   Error for ${symbol}: ${e.message} - ${JSON.stringify(e.response?.data)}`);
    }
}

async function run() {
    console.log('--- STARTING ASSET VERIFICATION TEST (BTC, ETH, SOL, GOLD) ---');
    
    const assets = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XAUTUSDT'];
    
    for (const asset of assets) {
        await sendSignal(asset, 'long');
        await new Promise(r => setTimeout(r, 3000)); // Sleep to avoid rate limits and let the bot process
    }
    
    console.log('\n--- MONITORING RESULTS (10s) ---');
    await new Promise(r => setTimeout(r, 10000));
    console.log('\n--- TEST COMPLETE ---');
}

run();
