/* eslint-disable */
const { Database } = require('../src/services/database');

(async () => {
    const db = new Database('./data/algotrade.db');
    await db.init();

    const sql = "SELECT user_id, COUNT(*) AS total, " +
                "SUM(CASE WHEN realized_pnl>0 THEN 1 ELSE 0 END) AS wins, " +
                "SUM(CASE WHEN realized_pnl<0 THEN 1 ELSE 0 END) AS losses, " +
                "SUM(CASE WHEN realized_pnl=0 THEN 1 ELSE 0 END) AS zeros, " +
                "ROUND(SUM(realized_pnl),2) AS pnl, " +
                "MIN(closed_at) AS first_closed, " +
                "MAX(closed_at) AS last_closed " +
                "FROM positions WHERE status='CLOSED' GROUP BY user_id";

    const res = db._db.exec(sql);
    if (!res[0]) { console.log('no closed positions at all'); process.exit(0); }

    const cols = res[0].columns;
    const rows = res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));

    console.log('Closed positions grouped by user_id:');
    for (const r of rows) {
        console.log({
            user_id: r.user_id === null ? 'NULL (orphaned)' : r.user_id,
            total: r.total,
            wins: r.wins,
            losses: r.losses,
            zeros: r.zeros,
            total_pnl: r.pnl,
            first_closed: r.first_closed ? new Date(r.first_closed).toISOString() : null,
            last_closed:  r.last_closed  ? new Date(r.last_closed).toISOString()  : null
        });
    }

    // Last 5 closed for context
    const last = db._db.exec("SELECT position_id, user_id, symbol, side, realized_pnl, closed_at FROM positions WHERE status='CLOSED' ORDER BY closed_at DESC LIMIT 5");
    if (last[0]) {
        console.log('\nLast 5 closed:');
        const c = last[0].columns;
        for (const v of last[0].values) {
            const row = Object.fromEntries(c.map((k, i) => [k, v[i]]));
            row.closed_at = row.closed_at ? new Date(row.closed_at).toISOString() : null;
            console.log(row);
        }
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
