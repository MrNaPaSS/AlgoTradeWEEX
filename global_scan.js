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
    const types = ['umcbl', 'dmcbl', 'cmcbl'];
    console.log('--- GLOBAL ACCOUNT SCAN ---');
    for (const t of types) {
        try {
            console.log(`Checking ${t}...`);
            const res = await request('GET', '/capi/v3/account/position/allPosition', { productType: t });
            const positions = res.data || [];
            if (positions.length > 0) {
                console.log(`Found ${positions.length} positions in ${t}:`);
                positions.forEach(p => console.log(`  - ${p.symbol} (${p.side}) size=${p.size}`));
            } else {
                console.log(`No positions in ${t}.`);
            }
        } catch (e) {
            console.log(`Error in ${t}: ${e.message}`);
        }
    }
    console.log('--- SCAN COMPLETE ---');
}

run();
