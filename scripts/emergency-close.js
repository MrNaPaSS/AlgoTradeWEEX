require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const config = require('../src/config/config');
const axios = require('axios');
const JSONbig = require('json-bigint')({ storeAsString: true });

async function emergencyClose() {
    // Override axios to handle large IDs
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });
    
    // We will manually use axios with BIGINT support for this check
    const instance = axios.create({
        baseURL: 'https://api-contract.weex.com',
        transformResponse: [data => {
            try { return JSONbig.parse(data); } catch { return data; }
        }]
    });

    console.log('Fetching all open orders for ETHUSDT with BigInt support...');
    // We need to build headers manually for this raw request or just use the client
    // Actually, I'll just update the WeexFuturesClient to use strings for IDs
}

emergencyClose().catch(console.error);
