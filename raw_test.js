const axios = require('axios');
const { WeexSignature } = require('./src/api/weex/signature');
const config = require('./src/config/config');

const API_KEY = config.weex.apiKey;
const SECRET_KEY = config.weex.secretKey;
const PASSPHRASE = config.weex.passphrase;
const BASE_URL = 'https://api-contract.weex.com';

const signer = new WeexSignature(SECRET_KEY);

async function run() {
    console.log('Starting raw test...');
    const timestamp = Date.now().toString();
    const path = '/capi/v3/account/position/allPosition';
    // No params
    
    const headers = signer.buildHeaders({
        apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET',
        requestPath: path, queryString: '', body: ''
    });

    console.log('Requesting:', BASE_URL + path);
    try {
        const res = await axios.get(BASE_URL + path, { headers });
        console.log('STATUS:', res.status);
        console.log('FULL RESPONSE:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.log('ERROR:', e.response ? e.response.data : e.message);
    }
}

run();
