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
    
    const queryString = !isPost && Object.keys(params).length
        ? new URLSearchParams(params).toString()
        : '';
    const body = isPost && Object.keys(params).length ? JSON.stringify(params) : '';

    const headers = signer.buildHeaders({
        apiKey: API_KEY,
        passphrase: PASSPHRASE,
        method: method.toUpperCase(),
        requestPath: path,
        queryString,
        body
    });

    let url = BASE_URL + path;
    if (queryString) url += '?' + queryString;

    const res = await axios({ 
        method, 
        url, 
        data: isPost ? params : undefined, 
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        }
    });
    return res.data;
}

async function run() {
    try {
        console.log('--- WEEX ACCOUNT SNAPSHOT ---');
        // V3 position endpoint: /capi/v3/account/position/allPosition
        const posRes = await request('GET', '/capi/v3/account/position/allPosition', { productType: 'umcbl' });
        console.log('Positions:', JSON.stringify(posRes.data || posRes, null, 2));
        console.log('--- END ---');
    } catch (e) {
        console.error('CRITICAL ERROR:', e.response ? e.response.data : e.message);
    }
}

run();
