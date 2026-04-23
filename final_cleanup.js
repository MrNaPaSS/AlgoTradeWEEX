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
        console.log('Fetching all positions...');
        const res = await request('GET', '/capi/v3/account/position/allPosition');
        const positions = res.data || [];
        console.log(`Found ${positions.length} positions.`);

        for (const p of positions) {
            console.log(`Checking position: ${p.symbol} (${p.side}) size=${p.size}`);
            
            if (p.symbol === 'ETHUSDT' || p.symbol === 'SOLUSDT') {
                console.log(`  >>> CLOSING ${p.symbol}...`);
                
                // Cancel orders
                try {
                    const orders = (await request('GET', '/capi/v3/openOrders', { symbol: p.symbol })).data || [];
                    for (const o of orders) {
                        await request('DELETE', '/capi/v3/order', { symbol: p.symbol, orderId: o.orderId });
                    }
                    const algos = (await request('GET', '/capi/v3/openAlgoOrders', { symbol: p.symbol })).data || [];
                    for (const a of algos) {
                        await request('DELETE', '/capi/v3/algoOrder', { symbol: p.symbol, orderId: a.orderId });
                    }
                } catch (e) { console.log(`      Order cleanup warning: ${e.message}`); }

                // Close
                const closeRes = await request('POST', '/capi/v3/order', {
                    symbol: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY',
                    positionSide: p.side, orderType: 'MARKET', quantity: p.size
                });
                console.log(`      Result: ${closeRes.code === '0' || closeRes.code === 0 ? 'SUCCESS' : JSON.stringify(closeRes)}`);
            } else if (p.symbol === 'BTCUSDT') {
                console.log('  >>> !!! SKIPPING BTCUSDT (LONG TERM) - SAFE !!!');
            } else {
                console.log(`  >>> Skipping ${p.symbol} - Not a test asset.`);
            }
        }
        console.log('Done.');
    } catch (e) {
        console.error('CRITICAL ERROR:', e.response ? e.response.data : e.message);
    }
}

run();
