/**
 * Одноразовый миграционный скрипт.
 * Назначает все orphaned позиции (user_id = NULL) активному пользователю.
 * Запустить ОДИН раз: node migrate_assign_positions.js
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'data', 'trades.db');

async function main() {
    const SQL = await initSqlJs();
    if (!fs.existsSync(DB_PATH)) {
        console.error('❌ Файл БД не найден:', DB_PATH);
        process.exit(1);
    }

    const buf = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(buf);

    // Найти единственного активного пользователя
    const usersRes = db.exec(`SELECT user_id, username FROM users WHERE is_active = 1`);
    if (!usersRes[0] || !usersRes[0].values.length) {
        console.error('❌ Нет активных пользователей в БД');
        db.close(); return;
    }
    if (usersRes[0].values.length > 1) {
        console.error('⚠️  Найдено несколько активных пользователей — укажи user_id вручную:');
        usersRes[0].values.forEach(r => console.log(`  user_id=${r[0]}, username=${r[1]}`));
        db.close(); return;
    }

    const [[targetUserId, username]] = usersRes[0].values;
    console.log(`\n→ Назначаю orphaned позиции пользователю: ${username} (${targetUserId})`);

    // Посмотреть сколько orphaned позиций
    const countRes = db.exec(`SELECT COUNT(*) FROM positions WHERE user_id IS NULL`);
    const orphanCount = countRes[0].values[0][0];
    console.log(`→ Найдено orphaned позиций: ${orphanCount}`);

    if (orphanCount === 0) {
        console.log('✅ Нечего мигрировать');
        db.close(); return;
    }

    // Обновить
    db.run(`UPDATE positions SET user_id = ? WHERE user_id IS NULL`, [String(targetUserId)]);
    console.log(`✅ Обновлено ${orphanCount} позиций`);

    // Сохранить файл
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log('✅ БД сохранена\n');

    // Проверка
    const checkRes = db.exec(`
        SELECT user_id, status, COUNT(*) as cnt, SUM(realized_pnl) as pnl
        FROM positions
        WHERE user_id = '${targetUserId}'
        GROUP BY status
    `);
    console.log('=== Статистика после миграции ===');
    checkRes[0]?.values.forEach(r => {
        console.log({ user_id: r[0], status: r[1], count: r[2], pnl: Number(r[3]).toFixed(2) });
    });

    db.close();
}

main().catch(console.error);
