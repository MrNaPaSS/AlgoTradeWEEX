const fs = require('fs');
const path = require('path');
const { Database } = require('./src/services/database');
const { PositionManager } = require('./src/services/positionManager');
const { LiveBroker } = require('./src/services/liveBroker');
const { WeexFuturesClient } = require('./src/api/weex/WeexFuturesClient');
require('dotenv').config();

async function check() {
    const db = new Database();
    await db.init();
    
    const client = new WeexFuturesClient({
        apiKey: process.env.WEEX_API_KEY,
        secretKey: process.env.WEEX_SECRET_KEY,
        passphrase: process.env.WEEX_API_PASSPHRASE
    });
    
    const broker = new LiveBroker(client);
    const pm = new PositionManager({ database: db, broker });
    
    await pm.syncWithExchange();
    const open = pm.getOpen();
    
    console.log('--- CURRENT OPEN POSITIONS ---');
    console.log(JSON.stringify(open, null, 2));
    process.exit(0);
}

check();
