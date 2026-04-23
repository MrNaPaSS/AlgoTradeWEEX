/**
 * COMPREHENSIVE LIVE SMOKE — C8 Phase 2 full scenario matrix.
 *
 * Exercises every critical production path against real WEEX exchange:
 *   1.  Pre-flight — balance, mark price, clean slate.
 *   2.  Open LONG ETHUSDT with attached SL + 3 TP ladder limits.
 *   3.  Verify exchange state: 1 SL plan order + 3 TP reduce-only limits.
 *   4.  Scenario A — Modify SL to breakeven (atomic modifyTpSlOrder).
 *   5.  Scenario B — Cancel TP3 individually, confirm TP1/TP2 intact (C3 regression).
 *   6.  Scenario C — Simulate TP1 fill via partial market close, verify residual.
 *   7.  Scenario D — Emergency close: cancel all bot orders + flatten.
 *   8.  Final balance reconciliation.
 *
 * Philosophy: we don't wait for natural price moves. TP hits are simulated
 * by issuing a partial reduce-only market order, which matches what WEEX
 * would do when a plan TP triggers.
 *
 * RUN:   node scripts/smoke-full-scenarios.js
 * ENV:   SMOKE_SYMBOL=ETHUSDT  SMOKE_QTY=0.03  SMOKE_LEVERAGE=5
 */

require('dotenv').config();
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { LiveBroker } = require('../src/services/LiveBroker');
const config = require('../src/config/config');

const SYMBOL = process.env.SMOKE_SYMBOL || 'ETHUSDT';
const QTY    = Number(process.env.SMOKE_QTY || 0.03);   // split into 3 x 0.01 TPs
const LEV    = Number(process.env.SMOKE_LEVERAGE || 5);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hr() { console.log('-----------------------------------------------------------'); }
function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function ok(msg)   { console.log(`   ✅ ${msg}`); }
function fail(msg) { console.log(`   ❌ ${msg}`); }
function info(msg) { console.log(`   ℹ️  ${msg}`); }

/** Match an order by multiple possible id fields (WEEX inconsistency). */
function idOf(o) {
    return String(o?.algoId || o?.orderId || o?.algoOrderId || o?.planOrderId || o?.id || '');
}

const passCount = { pass: 0, fail: 0 };
function assert(cond, okMsg, failMsg) {
    if (cond) { ok(okMsg); passCount.pass++; }
    else      { fail(failMsg); passCount.fail++; }
}

async function main() {
    hr();
    console.log('   C8 PHASE 2 COMPREHENSIVE SMOKE — ALL SCENARIOS');
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
    let slOrderId = null;
    let tpLadder = { tp1OrderId: null, tp2OrderId: null, tp3OrderId: null };
    let balanceStart = 0;

    try {
        // ---------------------------------------------------------------
        // 1. Pre-flight
        // ---------------------------------------------------------------
        step(1, 'Pre-flight — balance, mark price, sanity');
        balanceStart = await broker.getAvailableBalanceUsd();
        info(`Start balance: ${balanceStart} USDT`);
        if (!Number.isFinite(balanceStart) || balanceStart <= 0) {
            throw new Error(`No balance: ${balanceStart}`);
        }

        const candles = await client.getCandles({ symbol: SYMBOL, tf: '1m', limit: 1 });
        const markPrice = Number(candles?.[0]?.close);
        if (!Number.isFinite(markPrice) || markPrice <= 0) {
            throw new Error(`Invalid mark price: ${markPrice}`);
        }
        info(`Mark: ${markPrice}`);
        const notional = markPrice * QTY;
        const margin = notional / LEV;
        info(`Notional $${notional.toFixed(2)} | Margin $${margin.toFixed(2)}`);
        assert(margin * 1.1 < balanceStart, 'Sufficient margin', 'Margin too high');

        // ---------------------------------------------------------------
        // 1b. Pre-cleanup
        // ---------------------------------------------------------------
        step('1b', 'Pre-cleanup');
        try {
            const pre = await client.cancelAllForSymbol(SYMBOL);
            info(`Cancelled: ${pre.cancelled.length}  Skipped: ${pre.skipped.length}`);

            const positions0 = await client.getPositions();
            const list0 = Array.isArray(positions0) ? positions0 : positions0?.data || [];
            const pos0 = list0.find((p) => p.symbol === SYMBOL && Number(p.size || p.total) > 0);
            if (pos0) {
                const size0 = Number(pos0.size || pos0.total);
                const side0 = String(pos0.side || pos0.positionSide).toLowerCase();
                info(`Closing leftover: ${side0} ${size0}`);
                await broker.closeMarket({
                    symbol: SYMBOL, side: side0, quantity: size0,
                    entryPrice: Number(pos0.entryPrice)
                });
                await sleep(1500);
            }
            ok('Clean slate');
        } catch (err) {
            info(`Pre-cleanup note: ${err.message}`);
        }

        // ---------------------------------------------------------------
        // 2. Open LONG with attached SL
        // ---------------------------------------------------------------
        step(2, 'Open LONG with attached SL');
        const initialSl = Number((markPrice * 0.95).toFixed(2));
        info(`Initial SL: ${initialSl} (−5%)`);

        position = await broker.placeMarketOrder({
            symbol: SYMBOL,
            side: 'long',
            quantity: QTY,
            leverage: LEV,
            stopLoss: initialSl
        });
        slOrderId = position.slOrderId;
        assert(position.orderId, `Entry filled orderId=${position.orderId}`, 'No entry orderId');
        assert(slOrderId, `SL plan id captured: ${slOrderId}`, 'SL id missing');
        await sleep(1500);

        // ---------------------------------------------------------------
        // 3. Place TP ladder (3 reduce-only limits)
        // ---------------------------------------------------------------
        step(3, 'Place TP ladder 3×levels (reduce-only limits)');
        const tp1Price = Number((markPrice * 1.03).toFixed(2));
        const tp2Price = Number((markPrice * 1.06).toFixed(2));
        const tp3Price = Number((markPrice * 1.10).toFixed(2));
        info(`TP1=${tp1Price}  TP2=${tp2Price}  TP3=${tp3Price}`);

        tpLadder = await client.placeTpLadder({
            symbol: SYMBOL, side: 'long', totalQty: QTY,
            tp1Price, tp2Price, tp3Price,
            tp1Pct: 0.5, tp2Pct: 0.3, tp3Pct: 0.2
        });
        assert(tpLadder.tp1OrderId, `TP1 id=${tpLadder.tp1OrderId}`, 'TP1 not placed');
        assert(tpLadder.tp2OrderId, `TP2 id=${tpLadder.tp2OrderId}`, 'TP2 not placed');
        assert(tpLadder.tp3OrderId, `TP3 id=${tpLadder.tp3OrderId}`, 'TP3 not placed');
        await sleep(1500);

        // ---------------------------------------------------------------
        // 4. Verify ALL orders on exchange
        // ---------------------------------------------------------------
        step(4, 'Verify exchange state (1 SL plan + 3 TP limits)');
        const [openOrders, algoOrders] = await Promise.all([
            client.getOpenOrders(SYMBOL),
            client.getAlgoOpenOrders(SYMBOL)
        ]);
        const openList = Array.isArray(openOrders) ? openOrders : openOrders?.data || [];
        const algoList = Array.isArray(algoOrders) ? algoOrders : algoOrders?.data || [];
        info(`Limit orders on exchange: ${openList.length}`);
        info(`Plan (algo) orders on exchange: ${algoList.length}`);

        const slOnEx = algoList.find((o) => idOf(o) === String(slOrderId));
        assert(slOnEx, `SL on exchange triggerPrice=${slOnEx?.triggerPrice}`, 'SL missing');

        const tp1OnEx = openList.find((o) => String(o.orderId) === String(tpLadder.tp1OrderId));
        const tp2OnEx = openList.find((o) => String(o.orderId) === String(tpLadder.tp2OrderId));
        const tp3OnEx = openList.find((o) => String(o.orderId) === String(tpLadder.tp3OrderId));
        assert(tp1OnEx, `TP1 on exchange price=${tp1OnEx?.price}`, 'TP1 missing');
        assert(tp2OnEx, `TP2 on exchange price=${tp2OnEx?.price}`, 'TP2 missing');
        assert(tp3OnEx, `TP3 on exchange price=${tp3OnEx?.price}`, 'TP3 missing');

        // ---------------------------------------------------------------
        // 5. Scenario A — atomic breakeven SL move
        // ---------------------------------------------------------------
        step(5, 'Scenario A: Move SL to breakeven (atomic modifyTpSlOrder)');
        const newSl = Number((markPrice * 0.999).toFixed(2));  // below mark to satisfy exchange rule
        info(`New SL target: ${newSl} (was ${initialSl})`);
        const modRes = await broker.modifySlTp({
            symbol: SYMBOL, orderId: slOrderId, slTriggerPrice: newSl
        });
        assert(modRes.success, `modifySlTp {success:true, mode:${modRes.mode}}`, `modifySlTp failed: ${JSON.stringify(modRes)}`);
        assert(modRes.mode === 'modify', `Used atomic in-place modify`, `Fell back to mode=${modRes.mode}`);

        await sleep(1500);
        const algoAfter = await client.getAlgoOpenOrders(SYMBOL);
        const algoListAfter = Array.isArray(algoAfter) ? algoAfter : algoAfter?.data || [];
        const slMoved = algoListAfter.find((o) => idOf(o) === String(slOrderId));
        assert(slMoved, `Same SL algoId survived (no cancel+replace)`, `SL algoId disappeared — unexpected replace`);
        if (slMoved) {
            const delta = Math.abs(Number(slMoved.triggerPrice) - newSl) / newSl;
            assert(delta < 0.001, `SL triggerPrice updated to ${slMoved.triggerPrice} ≈ ${newSl}`,
                   `SL trigger mismatch ${slMoved.triggerPrice} vs ${newSl}`);
        }

        // ---------------------------------------------------------------
        // 6. Scenario B — cancel TP3 individually, TP1/TP2 must survive
        // ---------------------------------------------------------------
        step(6, 'Scenario B: Cancel TP3 individually (C3 regression guard)');
        await broker.cancelOrderById({ symbol: SYMBOL, orderId: tpLadder.tp3OrderId });
        await sleep(1500);
        const openAfterCancel = await client.getOpenOrders(SYMBOL);
        const openListAC = Array.isArray(openAfterCancel) ? openAfterCancel : openAfterCancel?.data || [];
        const tp1Still = openListAC.find((o) => String(o.orderId) === String(tpLadder.tp1OrderId));
        const tp2Still = openListAC.find((o) => String(o.orderId) === String(tpLadder.tp2OrderId));
        const tp3Gone  = !openListAC.find((o) => String(o.orderId) === String(tpLadder.tp3OrderId));
        assert(tp1Still, 'TP1 survived cancel(TP3)', 'TP1 gone — C3 regression!');
        assert(tp2Still, 'TP2 survived cancel(TP3)', 'TP2 gone — C3 regression!');
        assert(tp3Gone,  'TP3 actually cancelled', 'TP3 still alive — cancel failed');

        // ---------------------------------------------------------------
        // 7. Scenario C — simulate TP1 fill via partial market close
        // ---------------------------------------------------------------
        step(7, 'Scenario C: Simulate TP1 fill (cancel TP1 + partial market close 50%)');
        // Real natural TP1 fill = TP1 limit is FILLED (so it disappears from open
        // orders). We replicate by cancelling TP1 first, then market-closing.
        // Otherwise WEEX rejects with FAILED_PRECONDITION (reduce-only TP1 of
        // 0.015 would be stranded above residual 0.015 position).
        await broker.cancelOrderById({ symbol: SYMBOL, orderId: tpLadder.tp1OrderId });
        await sleep(500);
        const tp1Qty = Math.floor(QTY * 0.5 * 1000) / 1000;
        info(`TP1 cancelled, now market-closing ${tp1Qty} ETH to simulate fill`);
        await broker.closeMarket({
            symbol: SYMBOL, side: 'long', quantity: tp1Qty,
            entryPrice: markPrice, markPrice
        });
        await sleep(1500);

        const positionsMid = await client.getPositions();
        const posMidList = Array.isArray(positionsMid) ? positionsMid : positionsMid?.data || [];
        const posMid = posMidList.find((p) => p.symbol === SYMBOL);
        const residualQty = Number(posMid?.size || posMid?.total || 0);
        const expectedResidual = Number((QTY - tp1Qty).toFixed(3));
        info(`Residual position size: ${residualQty}  expected: ${expectedResidual}`);
        assert(Math.abs(residualQty - expectedResidual) < 0.001,
               `Residual matches expected after TP1 simulation`,
               `Residual mismatch ${residualQty} vs ${expectedResidual}`);

        // SL and TP2 must still be on exchange (TP3 was cancelled in scenario B)
        const [openMid, algoMid] = await Promise.all([
            client.getOpenOrders(SYMBOL), client.getAlgoOpenOrders(SYMBOL)
        ]);
        const openMidList = Array.isArray(openMid) ? openMid : openMid?.data || [];
        const algoMidList = Array.isArray(algoMid) ? algoMid : algoMid?.data || [];
        const slStillAfterFill = algoMidList.find((o) => idOf(o) === String(slOrderId));
        const tp2StillAfterFill = openMidList.find((o) => String(o.orderId) === String(tpLadder.tp2OrderId));
        assert(slStillAfterFill, 'SL plan order still on exchange after TP1 fill', 'SL gone after partial close!');
        assert(tp2StillAfterFill, 'TP2 still on exchange after TP1 fill', 'TP2 gone after partial close!');

        // ---------------------------------------------------------------
        // 8. Scenario D — emergency flatten
        // ---------------------------------------------------------------
        step(8, 'Scenario D: Emergency flatten (cancelAll + market close)');
        const cancelRes = await client.cancelAllForSymbol(SYMBOL);
        info(`Cancelled orders: ${cancelRes.cancelled.length}`);
        assert(cancelRes.cancelled.length >= 1, 'Cancel swept remaining SL/TP', 'Nothing cancelled — unexpected');

        const positionsFin = await client.getPositions();
        const finList = Array.isArray(positionsFin) ? positionsFin : positionsFin?.data || [];
        const posFin = finList.find((p) => p.symbol === SYMBOL && Number(p.size || p.total) > 0);
        if (posFin) {
            const size = Number(posFin.size || posFin.total);
            const side = String(posFin.side || posFin.positionSide).toLowerCase();
            const closeRes = await broker.closeMarket({
                symbol: SYMBOL, side, quantity: size,
                entryPrice: Number(posFin.entryPrice)
            });
            assert(closeRes.orderId, `Flatten orderId=${closeRes.orderId}`, 'No close orderId');
        } else {
            info('No residual to flatten');
        }

    } catch (err) {
        fail(`FATAL: ${err.message}`);
        console.error(err.stack);
        passCount.fail++;
    } finally {
        // Safety net — ensure absolutely clean state no matter what
        hr();
        step(9, 'Safety net cleanup + final balance');
        try {
            await client.cancelAllForSymbol(SYMBOL);
            const positions = await client.getPositions();
            const list = Array.isArray(positions) ? positions : positions?.data || [];
            const pos = list.find((p) => p.symbol === SYMBOL && Number(p.size || p.total) > 0);
            if (pos) {
                await broker.closeMarket({
                    symbol: SYMBOL,
                    side: String(pos.side || pos.positionSide).toLowerCase(),
                    quantity: Number(pos.size || pos.total),
                    entryPrice: Number(pos.entryPrice)
                });
            }
        } catch (err) { /* ignore */ }

        const balanceEnd = await broker.getAvailableBalanceUsd();
        info(`Start balance: ${balanceStart}`);
        info(`End balance:   ${balanceEnd}`);
        info(`Delta (fees+slippage): ${(balanceEnd - balanceStart).toFixed(4)} USDT`);

        hr();
        console.log(`   RESULTS: ${passCount.pass} passed, ${passCount.fail} failed`);
        hr();
        process.exitCode = passCount.fail === 0 ? 0 : 1;
    }
}

main().catch((err) => { console.error('UNCAUGHT:', err); process.exit(1); });
