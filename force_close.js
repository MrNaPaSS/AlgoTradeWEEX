const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');
const config = require('./src/config/config');

async function closeAll() {
    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });

    const positions = await client.getPositions();
    console.log('Open positions:', positions.length);

    for (const p of positions) {
        if (p.symbol === 'SOLUSDT' || p.symbol === 'ETHUSDT' || p.symbol === 'XAUTUSDT') {
            console.log(`Cleaning ${p.symbol}...`);
            try {
                // Cancel all open orders first
                const openOrders = await client.getOpenOrders({ symbol: p.symbol });
                console.log(`Found ${openOrders.length} open orders for ${p.symbol}`);
                for (const o of openOrders) {
                    await client.cancelOrder({ symbol: p.symbol, orderId: o.orderId });
                    console.log(`Cancelled order ${o.orderId}`);
                }

                console.log(`Closing ${p.symbol} ${p.side} ${p.size}...`);
                const res = await client.placeOrder({
                    symbol: p.symbol,
                    side: p.side === 'LONG' ? 'SELL' : 'BUY',
                    positionSide: p.side,
                    orderType: 'MARKET',
                    quantity: p.size
                });
                console.log('Result:', res.orderId);
            } catch (e) {
                console.error('Failed to clean/close:', e.message);
            }
        }
    }
}

closeAll();
