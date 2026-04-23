/* eslint-disable */
/**
 * Wipe every CLOSED position from the local DB and re-insert only the
 * 8 real bot trades (visible in the WEEX web UI as of 2026-04-23).
 * Everything before these is hand-run test data that must not pollute stats.
 *
 * Usage:
 *   node scripts/reset_stats.js            # shows what would change
 *   node scripts/reset_stats.js --apply    # actually writes
 */
const path = require('path');
const { Database } = require('../src/services/database');

const APPLY = process.argv.includes('--apply');

// Times are interpreted as UTC — they only need to land within the
// correct 7d/30d/today window, so TZ drift of a few hours is fine.
const ms = (iso) => new Date(iso + 'Z').getTime();

const REAL_TRADES = [
    // symbol, side, qty, entry, exit, pnl, opened, closed
    ['BTCUSDT',  'long',  0.14,   75036.8, 75726.1,   96.4950,  '2026-04-20T12:00:17', '2026-04-21T19:20:02'],
    ['XAUTUSDT', 'short', 1959,   4764.5,  4723.0,    81.3814,  '2026-04-21T12:00:06', '2026-04-21T21:42:04'],
    ['BTCUSDT',  'short', 0.128,  75010.3, 77882.4,  -367.6289, '2026-04-21T22:00:26', '2026-04-22T07:16:43'],
    ['XAUTUSDT', 'long',  2144,   4740.3,  4688.1,  -111.8799, '2026-04-22T12:00:07', '2026-04-23T02:13:24'],
    ['SOLUSDT',  'long',  105,    85.78,   87.31,    160.1250, '2026-04-20T18:00:15', '2026-04-23T04:37:52'],
    ['BTCUSDT',  'short', 0.132,  77686.3, 77873.6,  -24.7236, '2026-04-23T06:00:11', '2026-04-23T06:19:11'],
    ['ETHUSDT',  'long',  4089,   2318.13, 2370.96,  216.0304, '2026-04-20T15:00:12', '2026-04-23T11:09:27'],
    ['XAUTUSDT', 'short', 2093,   4679.4,  4677.8,    3.3631,  '2026-04-23T12:00:07', '2026-04-23T12:39:51'],
];

(async () => {
    const db = new Database(path.join(__dirname, '..', 'data', 'trades.db'));
    await db.init();

    const before = db._db.exec("SELECT COUNT(*), COALESCE(SUM(realized_pnl),0) FROM positions WHERE status='CLOSED'");
    const [bc, bp] = before[0].values[0];
    console.log(`Before: closed=${bc}, total_pnl=${Number(bp).toFixed(4)}`);

    if (!APPLY) {
        console.log('\nWill DELETE all CLOSED rows and INSERT the following 8 real trades:');
    } else {
        db._db.run("DELETE FROM positions WHERE status='CLOSED'");
    }

    for (const [symbol, side, qty, entry, exit_, pnl, openedIso, closedIso] of REAL_TRADES) {
        const opened = ms(openedIso);
        const closed = ms(closedIso);
        const id = 'real_' + require('crypto').createHash('sha1')
            .update(symbol + side + openedIso + closedIso).digest('hex').slice(0, 12);
        const gross = side === 'long' ? (exit_ - entry) * qty : (entry - exit_) * qty;
        console.log(`  ${id}  ${symbol}  ${side}  qty=${qty}  pnl=${pnl}  (sanity gross=${gross.toFixed(2)})`);

        if (APPLY) {
            db._db.run(
                `INSERT INTO positions (position_id, symbol, side, mode, status,
                    entry_price, total_quantity, remaining_quantity, leverage,
                    realized_pnl, sl_moved_to_breakeven,
                    opened_at, closed_at, user_id)
                 VALUES (?, ?, ?, 'live', 'CLOSED', ?, ?, 0, 5, ?, 0, ?, ?, NULL)`,
                [id, symbol, side, entry, qty, pnl, opened, closed]
            );
        }
    }

    if (APPLY) {
        db._markDirty();
        db._persistIfDirty?.();
        const after = db._db.exec("SELECT COUNT(*), COALESCE(SUM(realized_pnl),0) FROM positions WHERE status='CLOSED'");
        const [ac, ap] = after[0].values[0];
        console.log(`\nAfter:  closed=${ac}, total_pnl=${Number(ap).toFixed(4)}`);
    } else {
        console.log('\n(dry-run — nothing written. Re-run with --apply)');
    }

    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
