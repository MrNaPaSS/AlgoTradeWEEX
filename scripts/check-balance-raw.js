const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const API_KEY = process.env.WEEX_API_KEY;
const SECRET_KEY = process.env.WEEX_SECRET_KEY;
const PASSPHRASE = process.env.WEEX_API_PASSPHRASE;
const BASE_URL = 'https://api-contract.weex.com';
const ENDPOINT = '/capi/v3/account/balance';

async function check() {
    const timestamp = Date.now().toString();
    const method = 'GET';
    const signStr = timestamp + method + ENDPOINT;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(signStr).digest('base64');

    try {
        const res = await axios.get(BASE_URL + ENDPOINT, {
            headers: {
                'ACCESS-KEY': API_KEY,
                'ACCESS-SIGN': signature,
                'ACCESS-TIMESTAMP': timestamp,
                'ACCESS-PASSPHRASE': PASSPHRASE,
                'Content-Type': 'application/json'
            }
        });
        console.log('RAW BALANCE RESPONSE:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.log('FAILED:', err.response?.data || err.message);
    }
}

check();
