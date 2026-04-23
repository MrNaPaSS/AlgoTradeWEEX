/* eslint-disable */
/**
 * Backfill realized_pnl for historical CLOSED positions whose realized_pnl
 * is 0 (a side-effect of the old "already_closed" catch-branch that never
 * computed pnl when an exchange-attached SL/TP fired before the bot could
 * market-close).
 *
 * Strategy:
 *   1. Select every positions row with status='CLOSED' and realized_pnl=0
 *   2. For each, fetch /capi/v3/userTrades filtered by symbol and the
 *      [opened_at, closed_at + 5m] window
 *   3. Pick the fills whose positionSide matches the position's side and
 *      whose "action" is a CLOSE (for a LONG: side=SELL, positionSide=LONG;
 *      for a SHORT: side=BUY, positionSide=SHORT)
 *   4. Sum realizedPnl − commission across those fills
 *   5. UPDATE positions SET realized_pnl=? WHERE position_id=?
 *
 * Pass --dry-run to preview changes without writing. Pass --user-id=NULL (default)
 * or --user-id=123456 to scope.
 */
const path = require('path');
const { Database } = require('../src/services/database');
const { WeexFuturesClient } = require('../src/api/weex/WeexFuturesClient');
const { decrypt } = require('../src/utils/crypto');

const DRY = process.argv.includes('--dry-run');
// By default we subtract commission from realizedPnl (safe on exchanges that
// report gross pnl). Pass --gross if WEEX already nets out the closing fee.
const GROSS = process.argv.includes('--gross');
const userIdArg = (process.argv.find(a => a.startsWith('--user-id=')) || '').split('=')[1];

(async () => {
    const db = new Database(path.join(__dirname, '..', 'data', 'trades.db'));
    await db.init();

    // 1. Load API credentials — prefer env vars (single-user), fall back to first user row.
    let apiKey = process.env.WEEX_API_KEY;
    let secretKey = process.env.WEEX_SECRET_KEY;
    let passphrase = process.env.WEEX_PASSPHRASE;
    if (!apiKey || !secretKey || !passphrase) {
        const row = db._db.exec(
            "SELECT encrypted_api_key, encrypted_secret, encrypted_passphrase FROM users WHERE encrypted_api_key IS NOT NULL LIMIT 1"
        );
        if (!row[0]) {
            console.error('No API credentials found (neither env vars nor users table). Aborting.');
            process.exit(1);
        }
        const [encK, encS, encP] = row[0].values[0];
        apiKey     = decrypt(encK);
        secretKey  = decrypt(encS);
        passphrase = decrypt(encP);
    }

    const client = new WeexFuturesClient({ apiKey, secretKey, passphrase });

    // 2. Pick candidates.
    const whereUser = userIdArg === 'NULL' ? 'user_id IS NULL'
                    : userIdArg             ? 'user_id = ?'
                    : '1=1';
    const params = userIdArg && userIdArg !== 'NULL' ? [userIdArg] : [];
    const sql = `SELECT position_id, symbol, side, total_quantity, opened_at, closed_at
                 FROM positions
                 WHERE status='CLOSED' AND (realized_pnl = 0 OR realized_pnl IS NULL)
                   AND ${whereUser}
                 ORDER BY closed_at ASC`;
    const rs = db._db.exec(sql, params);
    if (!rs[0]) { console.log('Nothing to backfill.'); process.exit(0); }

    const cols = rs[0].columns;
    const rows = rs[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
    console.log(`Found ${rows.length} CLOSED positions with realized_pnl=0. Dry-run=${DRY}`);

    let updated = 0, skipped = 0, totalRecovered = 0;

    for (const p of rows) {
        // 5-minute safety buffer — exchange-attached SL can fire slightly after bot's closed_at.
        const start = p.opened_at;
        const end   = (p.closed_at || Date.now()) + 5 * 60 * 1000;

        let fills;
        try {
            fills = await client.getUserTrades({
                symbol: p.symbol, startTime: start, endTime: end, limit: 100
            });
        } catch (err) {
            console.warn(`  ${p.position_id} ${p.symbol}: fetch failed — ${err.message}`);
            skipped++;
            continue;
        }

        // Match CLOSE fills for this side.
        // LONG close  -> side=SELL, positionSide=LONG
        // SHORT close -> side=BUY,  positionSide=SHORT
        const wantSide = p.side === 'long' ? 'SELL' : 'BUY';
        const wantPos  = p.side === 'long' ? 'LONG' : 'SHORT';
        const closeFills = (fills || []).filter(f =>
            String(f.side).toUpperCase() === wantSide &&
            String(f.positionSide).toUpperCase() === wantPos
        );

        if (closeFills.length === 0) {
            console.warn(`  ${p.position_id} ${p.symbol} ${p.side}: 0 close fills in window — skipped`);
            skipped++;
            continue;
        }

        // Sum realizedPnl and subtract commission (commission is in USDT on USDT-M).
        let pnl = 0, commission = 0, qtySum = 0;
        for (const f of closeFills) {
            pnl += Number(f.realizedPnl || 0);
            commission += Number(f.commission || 0);
            qtySum += Number(f.qty || 0);
        }
        // --gross flag: assume realizedPnl already accounts for the closing fee
        // (matches the number WEEX shows in the web UI's "closed positions" tab).
        // Default: subtract commission explicitly (conservative).
        const netPnl = Number((GROSS ? pnl : pnl - commission).toFixed(6));

        console.log(`  ${p.position_id} ${p.symbol} ${p.side} qty=${p.total_quantity} -> ` +
                    `${closeFills.length} fills, qtySum=${qtySum.toFixed(4)}, ` +
                    `pnl=${pnl.toFixed(4)}, fee=${commission.toFixed(4)}, NET=${netPnl}`);

        if (!DRY) {
            db._db.run('UPDATE positions SET realized_pnl = ? WHERE position_id = ?',
                       [netPnl, p.position_id]);
        }
        updated++;
        totalRecovered += netPnl;

        // Gentle rate-limit to avoid hammering WEEX.
        await new Promise(r => setTimeout(r, 250));
    }

    if (!DRY) db._persistIfDirty?.();

    console.log('\n=== SUMMARY ===');
    console.log(`Updated:        ${updated}`);
    console.log(`Skipped:        ${skipped}`);
    console.log(`Total recovered realized_pnl: ${totalRecovered.toFixed(2)} USDT`);
    if (DRY) console.log('(dry-run — nothing written)');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
