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
        console.log('--- STARTING CLEANUP ---');
        const res = await request('GET', '/capi/v3/account/position/allPosition');
        const positions = res.data || [];
        console.log(`Found ${positions.length} total positions.`);

        for (const p of positions) {
            if (p.symbol === 'ETHUSDT' || p.symbol === 'SOLUSDT') {
                console.log(`>>> PROCESSING ${p.symbol} (${p.side}) size=${p.size}...`);
                
                // 1. Cancel Standard Orders
                const oRes = await request('GET', '/capi/v3/openOrders', { symbol: p.symbol });
                const orders = oRes.data || [];
                for (const o of orders) {
                    await request('DELETE', '/capi/v3/order', { symbol: p.symbol, orderId: o.orderId });
                    console.log(`   Cancelled order ${o.orderId}`);
                }

                // 2. Cancel Algo Orders
                const aRes = await request('GET', '/capi/v3/openAlgoOrders', { symbol: p.symbol });
                const algos = aRes.data || [];
                for (const a of algos) {
                    await request('DELETE', '/capi/v3/algoOrder', { symbol: p.symbol, orderId: a.orderId });
                    console.log(`   Cancelled algo ${a.orderId}`);
                }

                // 3. Market Close
                const cRes = await request('POST', '/capi/v3/order', {
                    symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY',
                    positionSide: p.side, orderType: 'MARKET', quantity: p.size
                });
                console.log(`   CLOSE RESULT: ${cRes.code === '0' || cRes.code === 0 ? 'SUCCESS' : JSON.stringify(cRes)}`);
            } else if (p.symbol === 'BTCUSDT') {
                console.log('>>> !!! SKIPPING BTCUSDT (LONG TERM) - POSITION SAFE !!!');
            } else {
                console.log(`>>> Skipping ${p.symbol} - out of scope.`);
            }
        }
        console.log('--- CLEANUP DONE ---');
    } catch (e) {
        console.error('CRITICAL ERROR:', e.response ? e.response.data : e.message);
    }
}

run();
