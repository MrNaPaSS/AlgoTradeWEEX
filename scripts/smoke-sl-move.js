/**
 * LIVE SMOKE TEST — C8 Phase 2 SL move verification.
 *
 * Flow:
 *   1. Check balance & mark price.
 *   2. Open a minimum BTCUSDT LONG with attached SL & TP on exchange.
 *   3. Verify SL/TP orders are visible on exchange (getOpenOrders).
 *   4. Call broker.modifySlTp() to move SL to a new (higher) price.
 *   5. Verify the new SL price is reflected on exchange.
 *   6. Close the position + cancel all bot orders (cleanup).
 *   7. Final balance report.
 *
 * SAFE DEFAULTS:
 *   - Uses BTCUSDT with quantity 0.001 (~$60 notional at 60k → ~$12 margin at 5x).
 *   - Both SL and TP are set well away from current price so they never trigger
 *     during the test window.
 *   - On any failure, cleanup attempts to cancel all open orders for the symbol
 *     and close the position at market.
 *
 * RUN:
 *   node scripts/smoke-sl-move.js
 */

require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const config = require('../src/config/config');
const logger = require('../src/utils/logger');

const SYMBOL = process.env.SMOKE_SYMBOL || 'ETHUSDT';
const QTY    = Number(process.env.SMOKE_QTY || 0.01);
const LEV    = Number(process.env.SMOKE_LEVERAGE || 5);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr() { console.log('-----------------------------------------------------------'); }
function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function ok(msg) { console.log(`   ✅ ${msg}`); }
function fail(msg) { console.log(`   ❌ ${msg}`); }
function info(msg) { console.log(`   ℹ️  ${msg}`); }

async function main() {
    hr();
    console.log('   C8 PHASE 2 LIVE SMOKE — SL MOVE VERIFICATION');
    hr();
    console.log(`   Symbol: ${SYMBOL}  |  Qty: ${QTY}  |  Leverage: ${LEV}x`);
    hr();

    const client = new WeexFuturesClient({
        apiKey: config.weex.apiKey,
        secretKey: config.weex.secretKey,
        passphrase: config.weex.passphrase
    });
    const broker = new LiveBroker({ client });

    let position = null;
    let slOrderIdInitial = null;

    try {
        // 1. Pre-flight
        step(1, 'Pre-flight — balance & mark price');
        const balance = await broker.getAvailableBalanceUsd();
        info(`Available USDT: ${balance}`);
        if (!Number.isFinite(balance) || balance <= 0) {
            throw new Error(`No USDT balance (${balance}) — cannot run smoke test`);
        }

        // Use klines for mark price — the ticker endpoint behaves inconsistently
        // on WEEX V3. Klines are rock-solid and we only need the latest close.
        const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
        const markPrice = Number(candles?.[0]?.close);
        if (!Number.isFinite(markPrice) || markPrice <= 0) {
            throw new Error(`Invalid mark price ${markPrice} for ${SYMBOL}`);
        }
        info(`Mark price: ${markPrice}`);
        const notional = markPrice * QTY;
        const margin = notional / LEV;
        info(`Notional: $${notional.toFixed(2)} | Required margin: $${margin.toFixed(2)}`);
        if (margin * 1.05 > balance) {
            throw new Error(`Margin $${margin.toFixed(2)} exceeds available balance $${balance}`);
        }
        ok('Pre-flight checks passed');

        // 1b. Pre-cleanup — cancel any lingering open orders for this symbol so
        //     WEEX does not reject the leverage update with "open orders exist".
        step('1b', 'Pre-cleanup — cancel lingering orders on symbol');
        try {
            const pre = await client.cancelAllForSymbol(SYMBOL);
            info(`Pre-clean: ${JSON.stringify(pre)}`);
            // Also close any leftover position
            const positions0 = await client.getPositions();
            const pos0 = (Array.isArray(positions0) ? positions0 : positions0?.data || [])
                .find((p) => p.symbol === SYMBOL && Number(p.size || p.total) > 0);
            if (pos0) {
                const size0 = Number(pos0.size || pos0.total);
                const side0 = String(pos0.side || pos0.positionSide).toLowerCase();
                info(`Closing leftover position before test: ${SYMBOL} ${side0} size=${size0}`);
                await broker.closeMarket({
                    symbol: SYMBOL, side: side0, quantity: size0,
                    entryPrice: Number(pos0.entryPrice)
                });
            }
            await sleep(2000);
            ok('Pre-cleanup done');
        } catch (err) {
            info(`Pre-cleanup note: ${err.message}`);
        }

        // 2. Open position with SL + TP
        step(2, 'Opening LONG with attached SL & TP');
        const initialSl = Number((markPrice * 0.95).toFixed(1));  // 5% below = safe
        const tpPrice   = Number((markPrice * 1.10).toFixed(1));  // 10% above = safe
        info(`Initial SL: ${initialSl}  |  TP: ${tpPrice}`);

        position = await broker.placeMarketOrder({
            symbol: SYMBOL,
            side: 'long',
            quantity: QTY,
            leverage: LEV,
            stopLoss: initialSl,
            tpPrice: tpPrice
        });
        slOrderIdInitial = position.slOrderId;
        const tpOrderIdInitial = position.tpOrderId;
        ok(`Market order filled  orderId=${position.orderId}`);
        if (slOrderIdInitial) ok(`SL plan order id captured: ${slOrderIdInitial}`);
        else fail('slOrderId NOT captured from placeTpSlOrder response — modify will fall back to cancel+replace');
        if (tpOrderIdInitial) ok(`TP plan order id captured: ${tpOrderIdInitial}`);
        else fail('tpOrderId NOT captured');
        await sleep(2000);

        // 3. Verify SL/TP plan orders on exchange via getAlgoOpenOrders
        step(3, 'Verifying SL/TP plan orders on exchange (getAlgoOpenOrders)');
        let algoOrders = await client.getAlgoOpenOrders(SYMBOL);
        const algoList = Array.isArray(algoOrders) ? algoOrders : (algoOrders?.data || []);
        info(`Algo (plan) orders count: ${algoList.length}`);
        if (algoList[0]) info(`Sample plan order keys: ${Object.keys(algoList[0]).join(',')}`);
        const idMatch = (o, target) => {
            const t = String(target);
            return [o.orderId, o.algoOrderId, o.planOrderId, o.id, o.algoId]
                .filter(Boolean).map(String).includes(t);
        };
        const slBefore = algoList.find((o) => idMatch(o, slOrderIdInitial));
        const tpBefore = algoList.find((o) => idMatch(o, tpOrderIdInitial));
        if (slBefore) ok(`SL on exchange  triggerPrice=${slBefore.triggerPrice}  planType=${slBefore.planType}  orderId=${slBefore.orderId}`);
        else fail('SL plan order NOT found on exchange');
        if (tpBefore) ok(`TP on exchange  triggerPrice=${tpBefore.triggerPrice}  planType=${tpBefore.planType}  orderId=${tpBefore.orderId}`);
        else fail('TP plan order NOT found on exchange');

        // 4. Move SL to breakeven (entry price)
        step(4, 'Moving SL to breakeven via broker.modifySlTp()');
        // Use 0.1% below current mark so WEEX "SL must be ≤ mark" rule doesn't
        // reject the modify on flat market. In real breakeven flow PositionManager
        // applies a similar guard itself.
        const newSl = Number((markPrice * 0.999).toFixed(1));
        info(`New SL target: ${newSl}  (was ${initialSl})`);
        try {
            const modRes = await broker.modifySlTp({
                symbol: SYMBOL,
                orderId: slOrderIdInitial,
                slTriggerPrice: newSl
            });
            ok(`modifySlTp returned: ${JSON.stringify(modRes).slice(0, 120)}`);
        } catch (err) {
            fail(`modifySlTp failed: ${err.message}`);
            throw err;
        }
        await sleep(2000);

        // 5. Verify new SL via getAlgoOpenOrders — same orderId must persist with new trigger
        step(5, 'Verifying new SL price on exchange (getAlgoOpenOrders)');
        algoOrders = await client.getAlgoOpenOrders(SYMBOL);
        const algoList2 = Array.isArray(algoOrders) ? algoOrders : (algoOrders?.data || []);
        const slAfter = algoList2.find((o) => idMatch(o, slOrderIdInitial));
        if (slAfter) {
            const trig = Number(slAfter.triggerPrice);
            if (Math.abs(trig - newSl) / newSl < 0.01) {
                ok(`New SL confirmed in-place  orderId=${slAfter.orderId}  triggerPrice=${trig} ≈ ${newSl}`);
            } else {
                fail(`SL orderId ${slAfter.orderId} survived but triggerPrice=${trig} ≠ expected ${newSl}`);
            }
        } else {
            fail(`SL orderId ${slOrderIdInitial} missing from plan orders after modify — possible cancel+replace happened`);
        }

        // 6. C3 regression: the TP plan order must still be on exchange unchanged.
        step(6, 'C3 regression: TP plan order intact after SL move');
        const tpAfter = algoList2.find((o) => idMatch(o, tpOrderIdInitial));
        if (tpAfter) {
            ok(`TP intact  orderId=${tpAfter.orderId}  triggerPrice=${tpAfter.triggerPrice}`);
        } else {
            fail(`TP orderId ${tpOrderIdInitial} GONE — C3 regression triggered (blanket wipe?)`);
        }

    } catch (err) {
        fail(`TEST ERROR: ${err.message}`);
        console.error(err.stack);
    } finally {
        // 7. Cleanup — cancel all bot orders + close position
        hr();
        step(7, 'Cleanup — cancel bot orders & close position');
        try {
            const cancelRes = await client.cancelAllForSymbol(SYMBOL);
            info(`Cancelled: ${JSON.stringify(cancelRes)}`);
        } catch (err) {
            fail(`cancel failed: ${err.message}`);
        }
        try {
            const positions = await client.getPositions();
            const pos = (Array.isArray(positions) ? positions : positions?.data || [])
                .find((p) => p.symbol === SYMBOL && Number(p.size || p.total) > 0);
            if (pos) {
                const size = Number(pos.size || pos.total);
                const side = String(pos.side || pos.positionSide).toLowerCase();
                info(`Closing leftover position: ${SYMBOL} ${side} size=${size}`);
                const closeRes = await broker.closeMarket({
                    symbol: SYMBOL,
                    side,
                    quantity: size,
                    entryPrice: Number(pos.entryPrice),
                    markPrice: Number(pos.markPrice) || undefined
                });
                ok(`Closed  orderId=${closeRes.orderId}  pnl=${closeRes.pnl?.toFixed(4)}`);
            } else {
                info('No open position to close');
            }
        } catch (err) {
            fail(`close failed: ${err.message}`);
        }

        const finalBal = await broker.getAvailableBalanceUsd();
        info(`Final USDT balance: ${finalBal}`);
        hr();
        console.log('   SMOKE TEST COMPLETE');
        hr();
    }
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
