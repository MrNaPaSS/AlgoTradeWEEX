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
    console.log(`--- DEBUG ORDERS FOR ${symbol} ---`);
    try {
        const timestamp = Date.now().toString();
        const path = '/capi/v3/openOrders';
        const qs = `symbol=${symbol}`;
        const headers = signer.buildHeaders({
            apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET',
            requestPath: path, queryString: qs, body: ''
        });

        const res = await axios.get(BASE_URL + path + '?' + qs, { headers });
        console.log('Standard Open Orders:', JSON.stringify(res.data, null, 2));

        const aPath = '/capi/v3/openAlgoOrders';
        const aHeaders = signer.buildHeaders({
            apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET',
            requestPath: aPath, queryString: qs, body: ''
        });
        const aRes = await axios.get(BASE_URL + aPath + '?' + qs, { headers: aHeaders });
        console.log('Algo Open Orders:', JSON.stringify(aRes.data, null, 2));

    } catch (e) {
        console.log('ERROR:', e.response ? e.response.data : e.message);
    }
}

run();
