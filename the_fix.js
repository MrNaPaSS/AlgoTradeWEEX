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

    try {
        const res = await axios({ method, url, data: isPost ? params : undefined, headers });
        return res.data;
    } catch (e) {
        throw new Error(`${e.message} - ${JSON.stringify(e.response ? e.response.data : 'no response')}`);
    }
}

async function run() {
    try {
        console.log('--- FINAL CLEANUP (v7) ---');
        // Get raw positions as string first to avoid precision loss
        const timestamp = Date.now().toString();
        const pPath = '/capi/v3/account/position/allPosition';
        const pH = signer.buildHeaders({ apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET', requestPath: pPath, queryString: '', body: '' });
        const pRes = await axios.get(BASE_URL + pPath, { headers: pH, transformResponse: [data => data] });
        
        // Use regex to find symbols and sizes
        const ethMatch = pRes.data.match(/"symbol":"ETHUSDT"[^}]+"size":"([^"]+)"[^}]+"side":"([^"]+)"/);
        const solMatch = pRes.data.match(/"symbol":"SOLUSDT"[^}]+"size":"([^"]+)"[^}]+"side":"([^"]+)"/);
        
        const targets = [];
        if (ethMatch) targets.push({ symbol: 'ETHUSDT', size: ethMatch[1], side: ethMatch[2] });
        if (solMatch) targets.push({ symbol: 'SOLUSDT', size: solMatch[1], side: solMatch[2] });
        
        console.log(`Found ${targets.length} targets.`);

        for (const t of targets) {
            console.log(`Cleaning ${t.symbol}...`);
            
            // 1. Nuke algos
            await request('DELETE', '/capi/v3/algoOpenOrders', { symbol: t.symbol });
            
            // 2. Get orders as raw string
            const oPath = '/capi/v3/openOrders';
            const oQS = `symbol=${t.symbol}`;
            const oH = signer.buildHeaders({ apiKey: API_KEY, passphrase: PASSPHRASE, method: 'GET', requestPath: oPath, queryString: oQS, body: '' });
            const oRes = await axios.get(BASE_URL + oPath + '?' + oQS, { headers: oH, transformResponse: [data => data] });
            
            // Regex for orderId
            const idRegex = /"orderId":(\d+)/g;
            let m;
            while ((m = idRegex.exec(oRes.data)) !== null) {
                const oid = m[1];
                console.log(`   Killing order ${oid}...`);
                const dQS = `symbol=${t.symbol}&orderId=${oid}`;
                const dH = signer.buildHeaders({ apiKey: API_KEY, passphrase: PASSPHRASE, method: 'DELETE', requestPath: '/capi/v3/order', queryString: dQS, body: '' });
                await axios.delete(BASE_URL + '/capi/v3/order?' + dQS, { headers: dH });
            }

            // 3. Market close
            const clB = {
                symbol: t.symbol, side: t.side === 'LONG' ? 'SELL' : 'BUY',
                positionSide: t.side, type: 'MARKET', quantity: t.size,
                newClientOrderId: `fix_${Date.now()}`
            };
            const clR = await request('POST', '/capi/v3/order', clB);
            console.log(`   CLOSE ${t.symbol}: ${clR.code === '0' || clR.code === 0 ? 'SUCCESS' : JSON.stringify(clR)}`);
            
            // 4. Ghost detection from error
            if (clR.msg && clR.msg.includes('order')) {
                const gMatch = clR.msg.match(/order (\d+)/);
                if (gMatch) {
                    const gid = gMatch[1];
                    console.log(`   Killing Ghost ${gid}...`);
                    const gQS = `symbol=${t.symbol}&orderId=${gid}`;
                    const gH = signer.buildHeaders({ apiKey: API_KEY, passphrase: PASSPHRASE, method: 'DELETE', requestPath: '/capi/v3/order', queryString: gQS, body: '' });
                    await axios.delete(BASE_URL + '/capi/v3/order?' + gQS, { headers: gH });
                    await request('POST', '/capi/v3/order', { ...clB, newClientOrderId: `fix2_${Date.now()}` });
                }
            }
        }
        
        console.log('Done.');
    } catch (e) {
        console.error('ERROR:', e.message);
    }
}

run();
