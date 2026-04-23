const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
require('dotenv').config();

async function testBalance() {
    const client = new WeexFuturesClient({
        apiKey: process.env.WEEX_API_KEY,
        secretKey: process.env.WEEX_SECRET_KEY,
        passphrase: process.env.WEEX_PASSPHRASE
    });

    try {
        console.log('Fetching balance...');
        const res = await client.getBalance();
        console.log('Balance result:', JSON.stringify(res, null, 2));
    } catch (err) {
        console.error('Balance Fetch Error:', err.message);
        if (err.response) {
            console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
        }
    }
}

testBalance();
