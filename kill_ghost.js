const axios = require('axios');
const { WeexSignature } = require('./src/api/weex/signature');
const config = require('./src/config/config');

const API_KEY = config.weex.apiKey;
const SECRET_KEY = config.weex.secretKey;
const PASSPHRASE = config.weex.passphrase;
const BASE_URL = 'https://api-contract.weex.com';

const signer = new WeexSignature(SECRET_KEY);

async function run() {
    const symbol = 'ETHUSDT';
    const badId = '740839842413281505';
    console.log(`--- KILLING GHOST ORDER ${badId} ---`);
    
    const commonHeaders = { 'Content-Type': 'application/json' };

    const endpoints = [
        { path: '/capi/v3/order', method: 'DELETE' },
        { path: '/capi/v3/algoOrder', method: 'DELETE' }
    ];

    for (const e of endpoints) {
        try {
            const qs = `symbol=${symbol}&orderId=${badId}`;
            const headers = signer.buildHeaders({
                apiKey: API_KEY, passphrase: PASSPHRASE, method: e.method,
                requestPath: e.path, queryString: qs, body: ''
            });
            const res = await axios({ method: e.method, url: BASE_URL + e.path + '?' + qs, headers });
            console.log(`Trying ${e.path}:`, JSON.stringify(res.data));
        } catch (err) {
            console.log(`Failed ${e.path}:`, err.response ? err.response.data : err.message);
        }
    }
}

run();
