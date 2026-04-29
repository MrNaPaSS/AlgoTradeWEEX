/* eslint-disable */
/**
 * One-off: clear tp1_price / tp1_order_id / exchange_tp_active for a position
 * whose TP1 was already filled but the fields weren't nulled (pre-fix state).
 *
 * Usage:
 *   node scripts/fix-tp1-fields.js <positionId>
 *
 * Example:
 *   node scripts/fix-tp1-fields.js 4KqwpMIfbFLt
 */
const path = require('path');
const { Database } = require('../src/services/database');

const positionId = process.argv[2];
if (!positionId) {
    console.error('Usage: node scripts/fix-tp1-fields.js <positionId>');
    process.exit(1);
}

(async () => {
    const db = new Database(path.join(__dirname, '..', 'data', 'trades.db'));
    await db.init();

    // Show before
    const before = db._db.exec(
        `SELECT position_id, tp1_order_id, tp1_price, exchange_tp_active, sl_moved_to_breakeven FROM positions WHERE position_id='${positionId}'`
    );
    if (!before[0]?.values?.length) {
        console.error(`Position ${positionId} not found.`);
        process.exit(1);
    }
    const cols = before[0].columns;
    console.log('Before:', Object.fromEntries(cols.map((c, i) => [c, before[0].values[0][i]])));

    // Clear TP1 fields
    await db.run(
        `UPDATE positions SET tp1_order_id=NULL, tp1_price=NULL, exchange_tp_active=0 WHERE position_id=?`,
        [positionId]
    );
    db._persistIfDirty();

    // Show after
    const after = db._db.exec(
        `SELECT position_id, tp1_order_id, tp1_price, exchange_tp_active, sl_moved_to_breakeven FROM positions WHERE position_id='${positionId}'`
    );
    console.log('After: ', Object.fromEntries(cols.map((c, i) => [c, after[0].values[0][i]])));
    console.log('Done. Restart the bot.');
    process.exit(0);
})().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
