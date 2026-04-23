const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

async function run() {
    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'data', 'trades.db');
    const filebuffer = fs.readFileSync(dbPath);
    const db = new SQL.Database(filebuffer);

    console.log('--- LAST 5 DECISIONS ---');
    const res = db.exec("SELECT decision_id, symbol, outcome, direction, confidence, created_at FROM decisions ORDER BY created_at DESC LIMIT 5");
    if (res.length > 0) {
        console.table(res[0].values.map(v => ({
            id: v[0],
            symbol: v[1],
            outcome: v[2],
            direction: v[3],
            conf: v[4],
            time: new Date(v[5]).toLocaleString()
        })));
    } else {
        console.log('No decisions found.');
    }

    console.log('\n--- LAST 5 RISK EVENTS ---');
    const resRisk = db.exec("SELECT event_type, symbol, reason, created_at FROM risk_events ORDER BY created_at DESC LIMIT 5");
    if (resRisk.length > 0) {
        console.table(resRisk[0].values.map(v => ({
            type: v[0],
            symbol: v[1],
            reason: v[2],
            time: new Date(v[3]).toLocaleString()
        })));
    } else {
        console.log('No risk events found.');
    }
}

run();
