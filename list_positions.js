const axios = require('axios');
const { WeexSignature } = require('./src/api/weex/signature');
const config = require('./src/config/config');

const API_KEY = config.weex.apiKey;
const SECRET_KEY = config.weex.secretKey;
const PASSPHRASE = config.weex.passphrase;
const BASE_URL = 'https://api-contract.weex.com';

const signer = new WeexSignature(SECRET_KEY);

async function request(method, path, params = {}) {
    const timestamp = Date.now().toString();
    const isPost = method === 'POST' || method === 'DELETE';
    const queryString = !isPost && Object.keys(params).length ? new URLSearchParams(params).toString() : '';
    const body = isPost && Object.keys(params).length ? JSON.stringify(params) : '';

    const headers = signer.buildHeaders({
        apiKey: API_KEY, passphrase: PASSPHRASE, method: method.toUpperCase(),
        requestPath: path, queryString, body
    });

    let url = BASE_URL + path;
    if (queryString) url += '?' + queryString;

    const res = await axios({ method, url, data: isPost ? params : undefined, headers });
    return res.data;
}

async function run() {
    try {
        const posRes = await request('GET', '/capi/v3/account/position/allPosition', { productType: 'umcbl' });
        const symbols = (posRes.data || []).map(p => `${p.symbol} (${p.side}) size=${p.size}`);
        console.log('ACTIVE SYMBOLS:', symbols.join(', '));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

run();
