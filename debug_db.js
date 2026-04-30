/**
 * Временный диагностический скрипт — запустить один раз на сервере:
 *   node debug_db.js
 * Показывает что реально есть в trades.db
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data', 'trades.db');

async function main() {
    const SQL = await initSqlJs();
    if (!fs.existsSync(DB_PATH)) {
        console.log('❌ Файл БД не найден:', DB_PATH);
        return;
    }
    const buf = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(buf);

    console.log('\n=== POSITIONS ===');
    const pos = db.exec(`
        SELECT position_id, symbol, side, mode, status,
               realized_pnl, user_id, opened_at, closed_at
        FROM positions
        ORDER BY opened_at DESC LIMIT 20
    `);
    if (pos[0]) {
        const cols = pos[0].columns;
        pos[0].values.forEach(row => {
            const obj = {};
            cols.forEach((c, i) => obj[c] = row[i]);
            console.log(obj);
        });
    } else {
        console.log('Позиций нет');
    }

    console.log('\n=== STATS BY user_id ===');
    const stats = db.exec(`
        SELECT user_id, status, mode, COUNT(*) as cnt, SUM(realized_pnl) as pnl
        FROM positions
        GROUP BY user_id, status, mode
    `);
    if (stats[0]) {
        stats[0].values.forEach(row => {
            console.log({ user_id: row[0], status: row[1], mode: row[2], count: row[3], pnl: row[4] });
        });
    }

    console.log('\n=== USERS ===');
    const users = db.exec(`SELECT user_id, username, is_active FROM users`);
    if (users[0]) {
        users[0].values.forEach(row => {
            console.log({ user_id: row[0], username: row[1], is_active: row[2] });
        });
    } else {
        console.log('Пользователей нет');
    }

    console.log('\n=== PARTIAL_CLOSES ===');
    const pc = db.exec(`SELECT COUNT(*) as cnt, SUM(pnl) as pnl FROM partial_closes`);
    if (pc[0]) {
        const row = pc[0].values[0];
        console.log({ partial_closes_count: row[0], total_pnl: row[1] });
    }

    db.close();
}

main().catch(console.error);
