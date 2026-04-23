require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { WeexWebSocket } = require('../src/api/weex/WeexWebSocket');
const { OpenRouterClient } = require('../src/llm/OpenRouterClient');
const config = require('../src/config/config');
const logger = require('../src/utils/logger');

async function runDiagnostics() {
    logger.info('=============================================');
    logger.info('   ALGO TRADE PRO: LIVE SYSTEM DIAGNOSTICS   ');
    logger.info('=============================================');

    let allOk = true;

    // 1. Check WEEX REST API
    logger.info('1. Testing WEEX REST API Authentication...');
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    try {
        const balance = await client.getBalance();
        const usdt = Array.isArray(balance) ? balance.find(b => b.asset === 'USDT' || b.marginCoin === 'USDT') : balance;
        logger.info(`   ✅ SUCCESS: Authenticated! Available Balance: ${usdt?.availableBalance || usdt?.available || '0'} USDT`);
    } catch (err) {
        logger.error(`   ❌ FAILED: WEEX REST API Error: ${err.message}`);
        allOk = false;
    }

    // 2. Check WebSocket
    logger.info('\n2. Testing WEEX WebSocket Connection...');
    const ws = new WeexWebSocket();
    let wsConnected = false;
    
    await new Promise((resolve) => {
        ws.on('open', () => {
            logger.info('   ✅ SUCCESS: WebSocket Connected to ' + config.weex.wsUrl);
            wsConnected = true;
            ws.subscribeKline('BTCUSDT', '1m');
            setTimeout(resolve, 1500); // Wait briefly to see if we get a pong/kline
        });
        ws.on('error', (err) => {
            logger.error(`   ❌ FAILED: WebSocket Error: ${err.message}`);
            resolve();
        });
        ws.connect();
    });

    if (!wsConnected) {
        logger.error('   ❌ FAILED: Could not establish WebSocket connection.');
        allOk = false;
    }
    ws.close();

    // 3. Check LLM (OpenRouter)
    logger.info('\n3. Testing LLM Arbiter (OpenRouter)...');
    if (config.openRouter.isConfigured) {
        const llm = new OpenRouterClient({
            apiKey: config.openRouter.apiKey,
            model: config.openRouter.model
        });
        try {
            const res = await llm.askJson([
                { role: 'system', content: 'You are a test bot. Respond with JSON { "status": "ok" }.' },
                { role: 'user', content: 'Ping' }
            ]);
            if (res && res.status === 'ok') {
                logger.info(`   ✅ SUCCESS: LLM responded correctly (${config.openRouter.model})`);
            } else {
                logger.warn(`   ⚠️ WARNING: LLM returned unexpected format: ${JSON.stringify(res)}`);
            }
        } catch (err) {
            logger.error(`   ❌ FAILED: LLM request failed: ${err.message}`);
            allOk = false;
        }
    } else {
        logger.warn('   ⚠️ SKIPPED: OpenRouter API key not configured in .env (Arbiter will run in FAST mode)');
    }

    logger.info('\n=============================================');
    if (allOk) {
        logger.info(' 🎉 ALL DIAGNOSTICS PASSED! SYSTEM IS READY.');
    } else {
        logger.error(' ⚠️ SOME CHECKS FAILED. PLEASE REVIEW LOGS.');
    }
    logger.info('=============================================');
    process.exit(allOk ? 0 : 1);
}

runDiagnostics();
