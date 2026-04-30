const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const logger = require('../utils/logger');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'trades.db');
const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
    position_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    entry_price REAL NOT NULL,
    total_quantity REAL NOT NULL,
    remaining_quantity REAL NOT NULL,
    leverage REAL NOT NULL,
    stop_loss REAL,
    tp1_price REAL,
    tp2_price REAL,
    tp3_price REAL,
    liquidation_price REAL,
    realized_pnl REAL DEFAULT 0,
    sl_moved_to_breakeven INTEGER DEFAULT 0,
    entry_order_id TEXT,
    sl_order_id TEXT,
    decision_id TEXT,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions(symbol, status);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at DESC);

CREATE TABLE IF NOT EXISTS partial_closes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    tp_level INTEGER NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    pnl REAL NOT NULL,
    order_id TEXT,
    closed_at INTEGER NOT NULL,
    FOREIGN KEY (position_id) REFERENCES positions(position_id)
);
CREATE INDEX IF NOT EXISTS idx_partial_closes_position ON partial_closes(position_id);

CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    signal_id TEXT,
    symbol TEXT NOT NULL,
    outcome TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence REAL NOT NULL,
    arbiter_mode TEXT NOT NULL,
    llm_invoked INTEGER DEFAULT 0,
    reasoning TEXT,
    votes_json TEXT,
    risk_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol_created ON decisions(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    confidence REAL NOT NULL,
    veto INTEGER DEFAULT 0,
    reasoning TEXT,
    metrics_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (decision_id) REFERENCES decisions(decision_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_decision ON agent_decisions(decision_id);

CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    tf TEXT NOT NULL,
    bar_timestamp INTEGER NOT NULL,
    indicators_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_ts ON market_snapshots(symbol, bar_timestamp DESC);

CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    symbol TEXT,
    reason TEXT,
    meta_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at DESC);

CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    telegram_chat_id TEXT NOT NULL,
    username TEXT,
    encrypted_api_key TEXT,
    encrypted_secret TEXT,
    encrypted_passphrase TEXT,
    is_active INTEGER DEFAULT 1,
    risk_max_daily_loss_pct REAL DEFAULT 3,
    risk_max_positions INTEGER DEFAULT 3,
    risk_leverage INTEGER DEFAULT 5,
    risk_position_size_pct REAL DEFAULT 5,
    risk_paused INTEGER DEFAULT 0,
    risk_pause_reason TEXT,
    symbols TEXT DEFAULT 'BTCUSDT,ETHUSDT',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

CREATE TABLE IF NOT EXISTS access_requests (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    username TEXT,
    weex_uid TEXT,
    status TEXT DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status);
CREATE INDEX IF NOT EXISTS idx_access_requests_user ON access_requests(user_id);
`;

class Database {
    constructor() {
        this._db = null;
        this._SQL = null;
        this._dirty = false;
        this._persistTimer = null;
    }

    async init() {
        this._SQL = await initSqlJs();
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        if (fs.existsSync(DB_PATH)) {
            const buffer = fs.readFileSync(DB_PATH);
            this._db = new this._SQL.Database(buffer);
        } else {
            this._db = new this._SQL.Database();
        }
        this._db.exec(SCHEMA);
        this._migrateSchema();
        this._ensureSchemaVersion();
        this._persistTimer = setInterval(() => this._persistIfDirty(), 5000);
        logger.info('[Database] initialised', { path: DB_PATH, schemaVersion: SCHEMA_VERSION });
    }

    async close() {
        if (this._persistTimer) clearInterval(this._persistTimer);
        this._persistIfDirty();
        if (this._db) this._db.close();
        this._db = null;
    }

    _migrateSchema() {
        const existingCols = new Set();
        const res = this._db.exec("PRAGMA table_info(positions)");
        if (res[0] && res[0].values) {
            for (const row of res[0].values) {
                existingCols.add(row[1]);
            }
        }

        if (!existingCols.has('sl_order_id')) {
            try {
                this._db.run('ALTER TABLE positions ADD COLUMN sl_order_id TEXT');
                this._markDirty();
                logger.info('[Database] migration v3: added positions.sl_order_id');
            } catch (err) {
                if (!/duplicate column/i.test(err.message)) {
                    logger.error('[Database] migration v3 failed', { message: err.message });
                    throw err;
                }
            }
        }

        const tpCols = ['tp1_order_id', 'tp2_order_id', 'tp3_order_id'];
        for (const col of tpCols) {
            if (!existingCols.has(col)) {
                try {
                    this._db.run(`ALTER TABLE positions ADD COLUMN ${col} TEXT`);
                    this._markDirty();
                    logger.info(`[Database] migration v4: added positions.${col}`);
                } catch (err) {
                    if (!/duplicate column/i.test(err.message)) {
                        logger.error(`[Database] migration v4 failed for ${col}`, { message: err.message });
                        throw err;
                    }
                }
            }
        }

        if (!existingCols.has('user_id')) {
            try {
                this._db.run('ALTER TABLE positions ADD COLUMN user_id TEXT');
                this._db.run('CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, status)');
                this._markDirty();
                logger.info('[Database] migration v5: added positions.user_id');
            } catch (err) {
                if (!/duplicate column/i.test(err.message)) {
                    logger.error('[Database] migration v5 failed', { message: err.message });
                    throw err;
                }
            }
        }

        // v6: users.risk_paused — persisted pause flag so kill-switch state survives restarts
        const userCols = new Set();
        const ures = this._db.exec('PRAGMA table_info(users)');
        if (ures[0] && ures[0].values) {
            for (const row of ures[0].values) userCols.add(row[1]);
        }
        if (!userCols.has('risk_paused')) {
            try {
                this._db.run('ALTER TABLE users ADD COLUMN risk_paused INTEGER DEFAULT 0');
                this._markDirty();
                logger.info('[Database] migration v6: added users.risk_paused');
            } catch (err) {
                if (!/duplicate column/i.test(err.message)) {
                    logger.error('[Database] migration v6 failed', { message: err.message });
                    throw err;
                }
            }
        }
        if (!userCols.has('risk_pause_reason')) {
            try {
                this._db.run('ALTER TABLE users ADD COLUMN risk_pause_reason TEXT');
                this._markDirty();
                logger.info('[Database] migration v6: added users.risk_pause_reason');
            } catch (err) {
                if (!/duplicate column/i.test(err.message)) {
                    logger.error('[Database] migration v6 (reason) failed', { message: err.message });
                    throw err;
                }
            }
        }

        // v8: language preference in access_requests
        const arCols = new Set();
        const arRes = this._db.exec('PRAGMA table_info(access_requests)');
        if (arRes[0] && arRes[0].values) {
            for (const row of arRes[0].values) arCols.add(row[1]);
        }
        if (!arCols.has('language')) {
            try {
                this._db.run("ALTER TABLE access_requests ADD COLUMN language TEXT DEFAULT 'en'");
                this._markDirty();
                logger.info('[Database] migration v8: added access_requests.language');
            } catch (err) {
                if (!/duplicate column/i.test(err.message)) {
                    logger.error('[Database] migration v8 failed', { message: err.message });
                }
            }
        }

        // v7: access_requests table for Telegram onboarding flow
        const accessTableExists = this._db.exec(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='access_requests'"
        );
        if (!accessTableExists[0]?.values?.length) {
            try {
                this._db.run(`CREATE TABLE IF NOT EXISTS access_requests (
                    request_id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL UNIQUE,
                    chat_id TEXT NOT NULL,
                    username TEXT,
                    weex_uid TEXT,
                    status TEXT DEFAULT 'pending',
                    created_at INTEGER NOT NULL,
                    processed_at INTEGER
                )`);
                this._db.run('CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)');
                this._db.run('CREATE INDEX IF NOT EXISTS idx_access_requests_user ON access_requests(user_id)');
                this._markDirty();
                logger.info('[Database] migration v7: created access_requests table');
            } catch (err) {
                if (!/already exists/i.test(err.message)) {
                    logger.error('[Database] migration v7 failed', { message: err.message });
                }
            }
        }
    }

    _ensureSchemaVersion() {
        const res = this._db.exec('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
        const current = res[0]?.values?.[0]?.[0];
        if (current !== SCHEMA_VERSION) {
            this._db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [
                SCHEMA_VERSION,
                Date.now()
            ]);
            this._markDirty();
        }
    }

    _markDirty() {
        this._dirty = true;
    }

    _persistIfDirty() {
        if (!this._dirty || !this._db) return;
        try {
            const data = this._db.export();
            fs.writeFileSync(DB_PATH, Buffer.from(data));
            this._dirty = false;
        } catch (err) {
            logger.error('[Database] persist failed', { message: err.message });
        }
    }

    // ─── Low-level accessors (async for interface parity with PG adapter) ──
    async run(sql, params = []) {
        this._db.run(sql, params);
        this._markDirty();
    }

    async all(sql, params = []) {
        const stmt = this._db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
    }

    async get(sql, params = []) {
        const rows = await this.all(sql, params);
        return rows[0] || null;
    }

    async insertPosition(p) {
        await this.run(
            `INSERT INTO positions (
                position_id, symbol, side, mode, status, entry_price, total_quantity,
                remaining_quantity, leverage, stop_loss, tp1_price, tp2_price, tp3_price,
                liquidation_price, realized_pnl, sl_moved_to_breakeven, entry_order_id,
                sl_order_id, tp1_order_id, tp2_order_id, tp3_order_id,
                decision_id, opened_at, closed_at, user_id
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                p.positionId, p.symbol, p.side, p.mode, p.status, p.entryPrice, p.totalQuantity,
                p.remainingQuantity, p.leverage, p.stopLoss ?? null, p.tp1Price ?? null,
                p.tp2Price ?? null, p.tp3Price ?? null, p.liquidationPrice ?? null,
                p.realizedPnl ?? 0, p.slMovedToBreakeven ? 1 : 0, p.entryOrderId ?? null,
                p.slOrderId ?? null, p.tp1OrderId ?? null, p.tp2OrderId ?? null, p.tp3OrderId ?? null,
                p.decisionId ?? null, p.openedAt, p.closedAt ?? null, p.userId ?? null
            ]
        );
    }

    async updatePosition(p) {
        await this.run(
            `UPDATE positions SET status=?, remaining_quantity=?, stop_loss=?, realized_pnl=?,
                sl_moved_to_breakeven=?, sl_order_id=?, tp1_order_id=?, tp2_order_id=?,
                tp3_order_id=?, closed_at=? WHERE position_id=?`,
            [
                p.status, p.remainingQuantity, p.stopLoss ?? null, p.realizedPnl ?? 0,
                p.slMovedToBreakeven ? 1 : 0, p.slOrderId ?? null,
                p.tp1OrderId ?? null, p.tp2OrderId ?? null, p.tp3OrderId ?? null,
                p.closedAt ?? null, p.positionId
            ]
        );
    }

    async getOpenPositions(symbol, userId) {
        if (symbol && userId) {
            return this.all(
                `SELECT * FROM positions WHERE symbol=? AND user_id=? AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`,
                [symbol, userId]
            );
        }
        if (userId) {
            return this.all(
                `SELECT * FROM positions WHERE user_id=? AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`,
                [userId]
            );
        }
        if (symbol) {
            return this.all(
                `SELECT * FROM positions WHERE symbol=? AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`,
                [symbol]
            );
        }
        return this.all(
            `SELECT * FROM positions WHERE status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`
        );
    }

    /**
     * Orphan positions = rows with user_id IS NULL. These are legacy single-user
     * trades opened before Mini App multi-user mode. The master PositionManager
     * (running on WEEX_API_KEY from .env, not tied to any Mini App user) manages
     * ONLY these rows — new trades for connected users are owned by their
     * per-user PositionManager and always carry a non-null user_id.
     */
    async getOrphanOpenPositions(symbol) {
        if (symbol) {
            return this.all(
                `SELECT * FROM positions WHERE symbol=? AND user_id IS NULL AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`,
                [symbol]
            );
        }
        return this.all(
            `SELECT * FROM positions WHERE user_id IS NULL AND status IN ('OPEN','PARTIAL') ORDER BY opened_at ASC`
        );
    }

    async insertPartialClose(pc) {
        await this.run(
            `INSERT INTO partial_closes (position_id, tp_level, price, quantity, pnl, order_id, closed_at)
             VALUES (?,?,?,?,?,?,?)`,
            [pc.positionId, pc.tpLevel, pc.price, pc.quantity, pc.pnl, pc.orderId ?? null, pc.closedAt]
        );
    }

    async getHitTpLevels(positionId) {
        const rows = await this.all(
            'SELECT tp_level FROM partial_closes WHERE position_id = ? ORDER BY tp_level ASC',
            [positionId]
        );
        return rows.map(r => Number(r.tp_level));
    }

    async insertDecision(d) {
        await this.run(
            `INSERT INTO decisions (decision_id, signal_id, symbol, outcome, direction, confidence,
                arbiter_mode, llm_invoked, reasoning, votes_json, risk_json, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                d.decisionId, d.signalId ?? null, d.symbol, d.outcome, d.direction, d.confidence,
                d.arbiterMode, d.llmInvoked ? 1 : 0, d.arbiterReasoning ?? '',
                JSON.stringify(d.votes || []), JSON.stringify(d.risk || {}), d.createdAt ?? Date.now()
            ]
        );
        for (const v of d.votes || []) {
            await this.run(
                `INSERT INTO agent_decisions (decision_id, agent_name, direction, confidence, veto, reasoning, metrics_json, created_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
                [
                    d.decisionId, v.agent, v.direction, v.confidence, v.veto ? 1 : 0,
                    v.reasoning ?? '', JSON.stringify(v.metrics || {}), Date.now()
                ]
            );
        }
    }

    async insertMarketSnapshot({ symbol, tf, barTimestamp, indicators }) {
        await this.run(
            `INSERT INTO market_snapshots (symbol, tf, bar_timestamp, indicators_json, created_at)
             VALUES (?,?,?,?,?)`,
            [symbol, tf, barTimestamp, JSON.stringify(indicators), Date.now()]
        );
    }

    async insertRiskEvent({ eventType, symbol, reason, meta }) {
        await this.run(
            `INSERT INTO risk_events (event_type, symbol, reason, meta_json, created_at)
             VALUES (?,?,?,?,?)`,
            [eventType, symbol ?? null, reason ?? null, JSON.stringify(meta || {}), Date.now()]
        );
    }

    async kvGet(key) {
        const row = await this.get('SELECT value FROM kv_store WHERE key=?', [key]);
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
    }

    async kvSet(key, value) {
        await this.run(
            `INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            [key, JSON.stringify(value), Date.now()]
        );
    }

    async getDailyStats(userId) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        return this._aggregateStats(userId, { sinceTs: todayStart.getTime() });
    }

    async getAllTimeStats(userId) {
        return this._aggregateStats(userId, { sinceTs: null });
    }

    async _aggregateStats(userId, { sinceTs = null } = {}) {
        // Counts (total/wins/losses) — only fully CLOSED positions
        // PnL (total_pnl) — CLOSED + PARTIAL positions that already have realized PnL
        //   (partial TP fills accumulate realized_pnl in the position row)
        // Period filter uses opened_at: the trade belongs to the period it was OPENED
        let sql = `
            SELECT
                SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS total,
                SUM(CASE WHEN status = 'CLOSED' AND realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN status = 'CLOSED' AND realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
                SUM(COALESCE(realized_pnl, 0)) AS total_pnl
            FROM positions
            WHERE (status = 'CLOSED' OR (status = 'PARTIAL' AND realized_pnl IS NOT NULL AND realized_pnl != 0))`;
        const params = [];
        if (sinceTs !== null) {
            sql += ` AND opened_at >= ?`;
            params.push(sinceTs);
        }
        if (userId) {
            sql += ` AND user_id = ?`;
            params.push(String(userId));
        }

        const stmt = this._db.prepare(sql);
        const row = stmt.getAsObject(params.length ? params : undefined);
        stmt.free();

        if (!row || row['total'] == null) return null;

        const total    = Number(row['total']    || 0);
        const wins     = Number(row['wins']     || 0);
        const losses   = Number(row['losses']   || 0);
        const totalPnl = Number(row['total_pnl']|| 0);
        return {
            totalTrades: total,
            winTrades: wins,
            lossTrades: losses,
            totalPnl,
            winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
            closedTrades: total
        };
    }

    /**
     * Recent CLOSED trades for sparkline / equity-curve rendering.
     * Returns oldest → newest within the window so the caller can build a
     * cumulative PnL series by simple running-sum.
     *
     * @param {string|number} userId
     * @param {Object} [opts]
     * @param {boolean} [opts.includeOrphaned=false]
     * @param {number}  [opts.sinceTs=null]    epoch ms; null = no lower bound
     * @param {number}  [opts.limit=60]        max rows (most-recent if window has more)
     * @returns {Promise<Array<{closedAt:number, realizedPnl:number}>>}
     */
    async getRecentClosedTrades(userId, { sinceTs = null, limit = 60 } = {}) {
        let sql = `SELECT closed_at, realized_pnl FROM positions
                   WHERE status = 'CLOSED' AND closed_at IS NOT NULL`;
        const params = [];
        if (sinceTs !== null) { sql += ` AND closed_at >= ?`; params.push(sinceTs); }
        if (userId) {
            sql += ` AND user_id = ?`;
            params.push(String(userId));
        }
        sql += ` ORDER BY closed_at DESC LIMIT ?`;
        params.push(Math.max(1, Math.min(500, Number(limit) || 60)));

        const stmt = this._db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
            const [t, p] = stmt.get();
            rows.push({ closedAt: Number(t), realizedPnl: Number(p) });
        }
        stmt.free();
        return rows.reverse(); // oldest → newest
    }

    /**
     * Equity-curve events for sparkline: combines partial TP closes (from
     * partial_closes table) with final position closes. Returns time-ordered
     * { closedAt, realizedPnl } events so the frontend can build a cumulative
     * PnL series with more granularity than whole-position closes alone.
     *
     * @param {string|number} userId
     * @param {Object} [opts]
     * @param {number}  [opts.sinceTs]  epoch ms lower bound (by partial-close time)
     * @param {number}  [opts.limit]    max rows (default 200)
     */
    async getRecentPnlEvents(userId, { sinceTs = null, limit = 200 } = {}) {
        const uid = String(userId);
        const maxLimit = Math.max(1, Math.min(1000, Number(limit) || 200));

        // 1. Partial TP close events
        let sqlPc = `
            SELECT pc.closed_at, pc.pnl AS realized_pnl
            FROM partial_closes pc
            JOIN positions p ON p.position_id = pc.position_id
            WHERE p.user_id = ?`;
        const paramsPc = [uid];
        if (sinceTs !== null) { sqlPc += ` AND pc.closed_at >= ?`; paramsPc.push(sinceTs); }
        sqlPc += ` ORDER BY pc.closed_at ASC LIMIT ?`;
        paramsPc.push(maxLimit);

        const pcRows = await this.all(sqlPc, paramsPc);

        // 2. Final-close events for positions NOT covered by partial_closes
        //    (SL hit, emergency close) — only rows where realized_pnl reflects
        //    the whole trade (no partial TP entries exist)
        let sqlFin = `
            SELECT p.closed_at, p.realized_pnl
            FROM positions p
            WHERE p.status = 'CLOSED'
              AND p.closed_at IS NOT NULL
              AND p.user_id = ?
              AND NOT EXISTS (
                  SELECT 1 FROM partial_closes pc2
                  WHERE pc2.position_id = p.position_id
              )`;
        const paramsFin = [uid];
        if (sinceTs !== null) { sqlFin += ` AND p.closed_at >= ?`; paramsFin.push(sinceTs); }
        sqlFin += ` ORDER BY p.closed_at ASC LIMIT ?`;
        paramsFin.push(maxLimit);

        const finRows = await this.all(sqlFin, paramsFin);

        // Merge and sort by time
        const all = [
            ...pcRows.map(r => ({ closedAt: Number(r.closed_at), realizedPnl: Number(r.realized_pnl) })),
            ...finRows.map(r => ({ closedAt: Number(r.closed_at), realizedPnl: Number(r.realized_pnl) }))
        ];
        all.sort((a, b) => a.closedAt - b.closedAt);
        return all.slice(-maxLimit); // keep latest N after merge
    }

    async debugUpdatePosition(symbol, fields, userId) {
        if (!userId) {
            // Hard-fail instead of silently clobbering every user's open position
            // on a shared symbol. Callers must pass the owning userId.
            throw new Error('debugUpdatePosition requires userId');
        }
        const positions = (await this.getOpenPositions(symbol, userId));
        for (const p of positions) {
            const setClause = Object.keys(fields).map(k => `${k} = ?`).join(', ');
            const values = Object.values(fields);
            this._db.run(`UPDATE positions SET ${setClause} WHERE position_id = ?`, [...values, p.position_id]);
        }
        this._markDirty();
    }

    // ─── User CRUD (multi-user) ──────────────────────────────────────────

    async insertUser(u) {
        await this.run(
            `INSERT INTO users (
                user_id, telegram_chat_id, username,
                encrypted_api_key, encrypted_secret, encrypted_passphrase,
                is_active, risk_max_daily_loss_pct, risk_max_positions,
                risk_leverage, risk_position_size_pct, symbols,
                created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                u.userId, u.telegramChatId, u.username ?? null,
                u.encryptedApiKey ?? null, u.encryptedSecret ?? null, u.encryptedPassphrase ?? null,
                u.isActive ? 1 : 0,
                u.riskMaxDailyLossPct ?? 3, u.riskMaxPositions ?? 3,
                u.riskLeverage ?? 5, u.riskPositionSizePct ?? 5,
                u.symbols ?? 'BTCUSDT,ETHUSDT',
                Date.now(), Date.now()
            ]
        );
    }

    async getUser(userId) {
        return this.get('SELECT * FROM users WHERE user_id = ?', [userId]);
    }

    async getUserByChatId(chatId) {
        return this.get('SELECT * FROM users WHERE telegram_chat_id = ?', [chatId]);
    }

    async getActiveUsers() {
        return this.all('SELECT * FROM users WHERE is_active = 1');
    }

    async updateUser(userId, fields) {
        const allowed = [
            'encrypted_api_key', 'encrypted_secret', 'encrypted_passphrase',
            'is_active', 'risk_max_daily_loss_pct', 'risk_max_positions',
            'risk_leverage', 'risk_position_size_pct', 'risk_paused',
            'risk_pause_reason', 'symbols', 'username'
        ];
        const updates = [];
        const values = [];
        for (const [key, val] of Object.entries(fields)) {
            if (allowed.includes(key)) {
                updates.push(`${key} = ?`);
                values.push(val);
            }
        }
        if (updates.length === 0) return;
        updates.push('updated_at = ?');
        values.push(Date.now());
        values.push(userId);
        await this.run(`UPDATE users SET ${updates.join(', ')} WHERE user_id = ?`, values);
    }

    async deleteUser(userId) {
        await this.run('DELETE FROM users WHERE user_id = ?', [userId]);
    }

    // ─── Access Requests ─────────────────────────────────────────────────────

    async getAccessRequest(userId) {
        const res = this._db.exec(
            'SELECT request_id, user_id, chat_id, username, weex_uid, status, language, created_at, processed_at FROM access_requests WHERE user_id = ?',
            [String(userId)]
        );
        if (!res[0]?.values?.length) return null;
        const cols = res[0].columns;
        return Object.fromEntries(cols.map((c, i) => [c, res[0].values[0][i]]));
    }

    async upsertAccessRequest({ requestId, userId, chatId, username, weexUid }) {
        await this.run(
            `INSERT INTO access_requests (request_id, user_id, chat_id, username, weex_uid, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'pending', ?)
             ON CONFLICT(user_id) DO UPDATE SET
               request_id = excluded.request_id,
               chat_id    = excluded.chat_id,
               username   = excluded.username,
               weex_uid   = excluded.weex_uid,
               status     = 'pending',
               created_at = excluded.created_at,
               processed_at = NULL`,
            [requestId, String(userId), String(chatId), username ?? null, weexUid ?? null, Date.now()]
        );
    }

    async updateAccessRequestStatus(userId, status) {
        await this.run(
            'UPDATE access_requests SET status = ?, processed_at = ? WHERE user_id = ?',
            [status, Date.now(), String(userId)]
        );
    }

    getUserLanguage(userId) {
        // sql.js: prepare().getAsObject(params) returns {col: val} or {} when no row
        const stmt = this._db.prepare('SELECT language FROM access_requests WHERE user_id = ?');
        const row = stmt.getAsObject([String(userId)]);
        stmt.free();
        return row && row['language'] ? row['language'] : 'en';
    }

    setUserLanguage(userId, lang) {
        // sql.js: run(sql, paramsArray) — params must be an array
        this._db.run("UPDATE access_requests SET language = ? WHERE user_id = ?", [lang, String(userId)]);
        this._markDirty();
    }
}

module.exports = { Database };
