const config = require('./src/config/config');
const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');

async function test() {
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    try {
        console.log('Testing ping...');
        const p = await client.ping();
        console.log('Ping result:', p);

        console.log('Testing balance...');
        const b = await client.getBalance();
        console.log('Balance result:', JSON.stringify(b).substring(0, 500));
    } catch (err) {
        console.error('Test failed:', err.message);
        if (err.payload) console.error('Payload:', err.payload);
    }
}

test();
