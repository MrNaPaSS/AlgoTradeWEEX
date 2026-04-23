const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('./src/services/liveBroker');
const config = require('./src/config/config');

async function run() {
    console.log('--- CLEANUP USING LIVE BROKER ---');
    
    const weexClient = new WeexFuturesClient({
        apiKey:     config.weex.apiKey,
        secretKey:  config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    const broker = new LiveBroker({ client: weexClient });

    try {
        const positions = await broker.getOpenPositions();
        console.log(`Found ${positions.length} active positions.`);

        for (const p of positions) {
            if (p.symbol === 'ETHUSDT' || p.symbol === 'SOLUSDT') {
                console.log(`>>> Closing ${p.symbol} (${p.side}) size=${p.remainingQuantity}...`);
                
                try {
                    // 1. Cancel all orders for the symbol (standard + algo)
                    await broker.cancelAllForSymbol(p.symbol);
                    
                    // 2. Market close
                    const res = await broker.closeMarket({
                        symbol: p.symbol,
                        side: p.side, // 'long' or 'short'
                        quantity: p.remainingQuantity
                    });
                    console.log(`   Result: SUCCESS (Order ID: ${res.orderId})`);
                } catch (e) {
                    console.log(`   Error closing ${p.symbol}: ${e.message}`);
                }
            } else if (p.symbol === 'BTCUSDT') {
                console.log('>>> !!! BTCUSDT IS SAFE !!!');
            }
        }
        console.log('--- DONE ---');
    } catch (e) {
        console.error('CRITICAL ERROR:', e.message);
    }
}

run();
