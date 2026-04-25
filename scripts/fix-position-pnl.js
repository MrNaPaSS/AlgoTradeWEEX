/* eslint-disable */
/**
 * Fix realized_pnl for ONE specific position by re-fetching the actual fills
 * from WEEX userTrades. Use this when a CLOSED position has a wrong PnL in
 * the DB (e.g. the old approximation bug that wrote pnl ≈ −fees because
 * market placeOrder didn't echo fillPrice and the caller-supplied markPrice
 * fallback equalled entryPrice).
 *
 * Usage:
 *   node scripts/fix-position-pnl.js --pid 4A9mG3zNchA3 [--dry-run]
 *   node scripts/fix-position-pnl.js --order-id 742890864933601505 [--dry-run]
 *
 * It will:
 *   1. Look up the position row by position_id (or scan for the close orderId)
 *   2. Decrypt the user's WEEX keys (or use env vars for single-user)
 *   3. Call getUserTrades({symbol, orderId, ...}) for the close orderId
 *      stored in entry_order_id... wait — we need the CLOSE order id, not
 *      the entry. The bot doesn't store the close orderId in DB today; we
 *      pass it via --order-id, or derive by scanning userTrades in the
 *      [closed_at − 30s, closed_at + 30s] window for opposite-side fills.
 *   4. Sum realizedPnl − commission across matching fills
 *   5. UPDATE positions SET realized_pnl=? WHERE position_id=?
 */
const path = require('path');
const { Database } = require('../src/services/database');
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { decrypt } = require('../src/utils/crypto');

const DRY = process.argv.includes('--dry-run');

function getArg(name) {
    const a = process.argv.find((x) => x.startsWith('--' + name + '='));
    if (a) return a.split('=')[1];
    const idx = process.argv.indexOf('--' + name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return null;
}

(async () => {
    const pid = getArg('pid');
    const orderIdArg = getArg('order-id');
    if (!pid && !orderIdArg) {
        console.error('Usage: node scripts/fix-position-pnl.js --pid <positionId> [--order-id <closeOrderId>] [--dry-run]');
        process.exit(1);
    }

    const db = new Database(path.join(__dirname, '..', 'data', 'trade.db'));
    await db.init();

    // 1. Locate the position row
    const sel = pid
        ? db._db.exec('SELECT * FROM positions WHERE position_id = ?', [pid])
        : db._db.exec('SELECT * FROM positions WHERE entry_order_id = ?', [orderIdArg]);
    if (!sel[0] || !sel[0].values?.[0]) {
        console.error('Position row not found for', pid || orderIdArg);
        process.exit(1);
    }
    const cols = sel[0].columns;
    const vals = sel[0].values[0];
    const row = Object.fromEntries(cols.map((c, i) => [c, vals[i]]));

    console.log('Position row:');
    console.log({
        position_id: row.position_id,
        symbol:      row.symbol,
        side:        row.side,
        user_id:     row.user_id,
        status:      row.status,
        entry_price: row.entry_price,
        total_quantity:    row.total_quantity,
        remaining_quantity: row.remaining_quantity,
        opened_at:   row.opened_at,
        closed_at:   row.closed_at,
        realized_pnl_OLD: row.realized_pnl
    });
    if (row.status !== 'CLOSED') {
        console.error('Position is not CLOSED, refusing to patch realized_pnl.');
        process.exit(1);
    }

    // 2. WEEX keys — env first, then user_id row, then any key-bearing user.
    let apiKey = process.env.WEEX_API_KEY;
    let secretKey = process.env.WEEX_SECRET_KEY;
    let passphrase = process.env.WEEX_PASSPHRASE;
    if (!apiKey || !secretKey || !passphrase) {
        const lookupSql = row.user_id
            ? 'SELECT encrypted_api_key, encrypted_secret, encrypted_passphrase FROM users WHERE user_id = ? LIMIT 1'
            : 'SELECT encrypted_api_key, encrypted_secret, encrypted_passphrase FROM users WHERE encrypted_api_key IS NOT NULL LIMIT 1';
        const userRows = row.user_id
            ? db._db.exec(lookupSql, [row.user_id])
            : db._db.exec(lookupSql);
        if (!userRows[0]?.values?.[0]) {
            console.error('No API credentials available. Set WEEX_API_KEY/WEEX_SECRET_KEY/WEEX_PASSPHRASE env or seed users table.');
            process.exit(1);
        }
        const [encK, encS, encP] = userRows[0].values[0];
        apiKey     = decrypt(encK);
        secretKey  = decrypt(encS);
        passphrase = decrypt(encP);
    }
    const client = new WeexFuturesClient({ apiKey, secretKey, passphrase });

    // 3. Find close fills.
    const oppositeSide = row.side === 'long' ? 'SELL' : 'BUY';
    const expectedPositionSide = row.side === 'long' ? 'LONG' : 'SHORT';
    let fills = [];
    if (orderIdArg) {
        fills = await client.getUserTrades({ symbol: row.symbol, orderId: orderIdArg, limit: 50 });
        console.log('Fills for orderId', orderIdArg, ':', fills?.length || 0);
    } else {
        // Scan a window around closed_at for opposite-side fills on this symbol.
        const start = Number(row.closed_at) - 60_000;
        const end   = Number(row.closed_at) + 60_000;
        const all = await client.getUserTrades({ symbol: row.symbol, startTime: start, endTime: end, limit: 100 });
        fills = (all || []).filter((f) =>
            String(f.side).toUpperCase() === oppositeSide &&
            String(f.positionSide).toUpperCase() === expectedPositionSide
        );
        console.log(`Scanned ${all?.length || 0} fills in [${start}..${end}], matched ${fills.length} close-side`);
    }

    if (!fills || fills.length === 0) {
        console.error('No matching fills found on WEEX. Cannot rebuild PnL.');
        process.exit(1);
    }

    // 4. Sum.
    let pnlSum = 0;
    let qtySum = 0;
    let feeSum = 0;
    for (const f of fills) {
        const realized = Number(f.realizedPnl || 0);
        const fee = Math.abs(Number(f.commission || 0));
        pnlSum += realized - fee;
        feeSum += fee;
        qtySum += Number(f.qty || 0);
        console.log('  fill:', {
            time: new Date(Number(f.time)).toISOString(),
            price: f.price, qty: f.qty,
            realizedPnl: f.realizedPnl, commission: f.commission, side: f.side, positionSide: f.positionSide
        });
    }

    console.log('Computed:');
    console.log({
        pnlSum_net: pnlSum,
        commissionSum: feeSum,
        qtySum,
        was: row.realized_pnl
    });

    if (DRY) {
        console.log('--dry-run: not writing.');
        process.exit(0);
    }

    db._db.run('UPDATE positions SET realized_pnl = ? WHERE position_id = ?', [pnlSum, row.position_id]);
    db.persist?.();
    console.log('OK — updated realized_pnl for', row.position_id, 'from', row.realized_pnl, 'to', pnlSum);
    process.exit(0);
})().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
