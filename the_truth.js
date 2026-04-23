const axios = require('axios');
const { WeexSignature } = require('./src/api/weex/signature');
const config = require('./src/config/config');

const API_KEY = config.weex.apiKey;
const SECRET_KEY = config.weex.secretKey;
const PASSPHRASE = config.weex.passphrase;
const BASE_URL = 'https://api-contract.weex.com';

const signer = new WeexSignature(SECRET_KEY);

async function run() {
    const timestamp = Date.now().toString();
    const path = '/capi/v3/account/position/allPosition';
    const headers = signer.buildHeaders({
        apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET',
        requestPath: path, queryString: '', body: ''
    });

    try {
        const res = await axios.get(BASE_URL + path, { headers });
        console.log('--- THE TRUTH ---');
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.log('ERROR:', e.message);
    }
}

run();
