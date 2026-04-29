/* eslint-disable */
/**
 * Cleanup phantom duplicate positions.
 *
 * Symptom: a single live exchange position appears as TWO rows in the local
 * positions table (same symbol + side + status='OPEN'/'PARTIAL'). The
 * "phantom" row has all *_order_id fields null because it was created by
 * syncWithExchange after a webhook open() race — sync didn't see the
 * just-opened in-memory entry and went down the "restore missing" branch.
 *
 * Fix: for each (user_id, symbol, side, status='OPEN'/'PARTIAL') group with
 * count>1, keep the row that has at least one of (sl_order_id, tp1_order_id,
 * tp2_order_id, tp3_order_id) populated — that's the bot-tracked one. Mark
 * the phantom(s) as status='ABANDONED' with closed_at=NOW so it disappears
 * from the dashboard and stats.
 *
 * Pass --dry-run to preview without writing.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-positions.js --dry-run
 *   node scripts/cleanup-duplicate-positions.js
 */
const path = require('path');
const { Database } = require('../src/services/database');

const DRY = process.argv.includes('--dry-run');

(async () => {
    const db = new Database(path.join(__dirname, '..', 'data', 'trades.db'));
    await db.init();

    const sql = `
        SELECT position_id, user_id, symbol, side, status,
               entry_price, total_quantity, remaining_quantity,
               sl_order_id, tp1_order_id, tp2_order_id, tp3_order_id,
               sl_moved_to_breakeven, opened_at
        FROM positions
        WHERE status IN ('OPEN','PARTIAL')
        ORDER BY symbol, side, opened_at DESC
    `;
    const res = db._db.exec(sql);
    if (!res[0] || !res[0].values?.length) {
        console.log('No open positions in DB.');
        process.exit(0);
    }

    const cols = res[0].columns;
    const rows = res[0].values.map((v) => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

    // Group by (user_id, symbol, side)
    const groups = new Map();
    for (const r of rows) {
        const k = `${r.user_id || 'NULL'}|${r.symbol}|${r.side}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }

    const phantoms = [];
    for (const [key, group] of groups) {
        if (group.length < 2) continue;

        // "Tracked" rows have at least one orderId populated. Phantoms have all null.
        const tracked = group.filter((r) =>
            r.sl_order_id || r.tp1_order_id || r.tp2_order_id || r.tp3_order_id
        );
        const naked   = group.filter((r) =>
            !r.sl_order_id && !r.tp1_order_id && !r.tp2_order_id && !r.tp3_order_id
        );

        if (tracked.length === 0) {
            console.warn(`! group ${key} has ${group.length} rows but NONE has orderIds — skipping (manual review needed)`);
            continue;
        }
        if (tracked.length > 1) {
            console.warn(`! group ${key} has multiple TRACKED rows (${tracked.length}) — skipping (manual review needed)`);
            continue;
        }

        const keep = tracked[0];
        const drops = naked;

        console.log(`\nGroup ${key} (${group.length} rows):`);
        console.log(`  KEEP   ${keep.position_id}  entry=${keep.entry_price}  qty=${keep.remaining_quantity}/${keep.total_quantity}  sl=${keep.sl_order_id || '—'}  be=${keep.sl_moved_to_breakeven}`);
        for (const d of drops) {
            console.log(`  DROP   ${d.position_id}  entry=${d.entry_price}  qty=${d.remaining_quantity}/${d.total_quantity}  (no orderIds — phantom)`);
            phantoms.push(d.position_id);
        }
    }

    if (phantoms.length === 0) {
        console.log('\nNo phantom duplicates found.');
        process.exit(0);
    }

    console.log(`\nTotal phantoms to mark ABANDONED: ${phantoms.length}`);
    if (DRY) {
        console.log('--dry-run: not writing.');
        process.exit(0);
    }

    const now = Date.now();
    for (const pid of phantoms) {
        await db.run(
            `UPDATE positions SET status='ABANDONED', closed_at=? WHERE position_id=?`,
            [now, pid]
        );
    }
    db._persistIfDirty();

    // Verify
    const v = db._db.exec(
        `SELECT position_id, status, closed_at FROM positions WHERE position_id IN (${phantoms.map(() => '?').join(',')})`,
        phantoms
    );
    if (v[0]) {
        console.log('\nVerification:');
        v[0].values.forEach((row) => console.log(`  ${row.join(' | ')}`));
    }
    console.log('\nDone. Restart the bot for changes to take effect in memory.');
    process.exit(0);
})().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
