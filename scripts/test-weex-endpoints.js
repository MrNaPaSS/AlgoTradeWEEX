const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const API_KEY = process.env.WEEX_API_KEY;
const SECRET_KEY = process.env.WEEX_SECRET_KEY;
const PASSPHRASE = process.env.WEEX_API_PASSPHRASE;
const BASE_URL = 'https://api-contract.weex.com';

const endpoints = [
    '/capi/v3/account/allPosition',
    '/capi/v3/position/allPosition',
    '/capi/v3/account/positions',
    '/capi/v3/position/list',
    '/capi/v3/account/positionRisk',
    '/capi/v3/account/positionInfo',
    '/capi/v3/position/all-position',
    '/capi/v3/account/allPositions',
    '/capi/v3/account/position/allPosition',
    '/capi/v3/account/position/list',
    '/capi/v3/account/position-risk',
    '/capi/v3/position/position-risk',
    '/capi/v3/account/all-position'
];

async function test() {
    for (const endpoint of endpoints) {
        const timestamp = Date.now().toString();
        const method = 'GET';
        const signStr = timestamp + method + endpoint;
        const signature = crypto.createHmac('sha256', SECRET_KEY).update(signStr).digest('hex');

        try {
            console.log(`Testing ${endpoint}...`);
            const res = await axios.get(BASE_URL + endpoint, {
                headers: {
                    'ACCESS-KEY': API_KEY,
                    'ACCESS-SIGN': signature,
                    'ACCESS-TIMESTAMP': timestamp,
                    'ACCESS-PASSPHRASE': PASSPHRASE,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ SUCCESS [${res.status}]: ${endpoint}`);
            console.log('Data:', JSON.stringify(res.data).substring(0, 100));
            return;
        } catch (err) {
            console.log(`❌ FAILED [${err.response?.status || err.message}]: ${endpoint}`);
        }
    }
}

test();
