const { Pool } = require('pg');
const logger = require('../utils/logger');

/**
 * PostgreSQL adapter with the same public interface as `Database` (sql.js).
 *
 * Used when `DATABASE_URL` is set (e.g. render.com managed PostgreSQL).
 * All methods are async and return native Promises.
 *
 * Placeholder style: `$1, $2, ...` (PostgreSQL native).
 * Result rows are returned as plain objects, matching the shape produced by
 * sql.js `getAsObject()` for the same queries.
 */

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS positions (
        position_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        total_quantity DOUBLE PRECISION NOT NULL,
        remaining_quantity DOUBLE PRECISION NOT NULL,
        leverage DOUBLE PRECISION NOT NULL,
        stop_loss DOUBLE PRECISION,
        tp1_price DOUBLE PRECISION,
        tp2_price DOUBLE PRECISION,
        tp3_price DOUBLE PRECISION,
        liquidation_price DOUBLE PRECISION,
        realized_pnl DOUBLE PRECISION DEFAULT 0,
        sl_moved_to_breakeven INTEGER DEFAULT 0,
        entry_order_id TEXT,
        sl_order_id TEXT,
        tp1_order_id TEXT,
        tp2_order_id TEXT,
        tp3_order_id TEXT,
        decision_id TEXT,
        user_id TEXT,
        opened_at BIGINT NOT NULL,
        closed_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_positions_symbol_status ON positions(symbol, status)`,
    `CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, status)`,

    `CREATE TABLE IF NOT EXISTS partial_closes (
        id SERIAL PRIMARY KEY,
        position_id TEXT NOT NULL,
        tp_level INTEGER NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        pnl DOUBLE PRECISION NOT NULL,
        order_id TEXT,
        closed_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_partial_closes_position ON partial_closes(position_id)`,

    `CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        signal_id TEXT,
        symbol TEXT NOT NULL,
        outcome TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        arbiter_mode TEXT NOT NULL,
        llm_invoked INTEGER DEFAULT 0,
        reasoning TEXT,
        votes_json TEXT,
        risk_json TEXT,
        created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_decisions_symbol_created ON decisions(symbol, created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS agent_decisions (
        id SERIAL PRIMARY KEY,
        decision_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        veto INTEGER DEFAULT 0,
        reasoning TEXT,
        metrics_json TEXT,
        created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_decisions_decision ON agent_decisions(decision_id)`,

    `CREATE TABLE IF NOT EXISTS market_snapshots (
        id SERIAL PRIMARY KEY,
        symbol TEXT NOT NULL,
        tf TEXT NOT NULL,
        bar_timestamp BIGINT NOT NULL,
        indicators_json TEXT NOT NULL,
        created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_snapshots_symbol_ts ON market_snapshots(symbol, bar_timestamp DESC)`,

    `CREATE TABLE IF NOT EXISTS risk_events (
        id SERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        symbol TEXT,
        reason TEXT,
        meta_json TEXT,
        created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_risk_events_created ON risk_events(created_at DESC)`,

    `CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        telegram_chat_id TEXT NOT NULL,
        username TEXT,
        encrypted_api_key TEXT,
        encrypted_secret TEXT,
        encrypted_passphrase TEXT,
        is_active INTEGER DEFAULT 1,
        risk_max_daily_loss_pct DOUBLE PRECISION DEFAULT 3,
        risk_max_positions INTEGER DEFAULT 3,
        risk_leverage INTEGER DEFAULT 5,
        risk_position_size_pct DOUBLE PRECISION DEFAULT 5,
        symbols TEXT DEFAULT 'BTCUSDT,ETHUSDT',
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active)`
];

const SCHEMA_VERSION = 5;

/**
 * Translate SQLite-style `?` placeholders into PostgreSQL `$1, $2, ...`.
 * Naive but correct for the SQL we issue (no literal `?` inside strings).
 */
function toPgPlaceholders(sql) {
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}

class DatabasePg {
    constructor(connectionString) {
        const useSsl = !/localhost|127\.0\.0\.1/.test(String(connectionString || ''));
        this._pool = new Pool({
            connectionString,
            ssl: useSsl ? { rejectUnauthorized: false } : false,
            max: 10,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000
        });

        this._pool.on('error', (err) => {
            logger.error('[DatabasePg] idle client error', { message: err.message });
        });
    }

    async init() {
        const client = await this._pool.connect();
        try {
            for (const stmt of SCHEMA_STATEMENTS) {
                await client.query(stmt);
            }
            await this._runMigrations(client);
            await this._ensureSchemaVersion(client);
        } finally {
            client.release();
        }
        logger.info('[DatabasePg] initialised', { schemaVersion: SCHEMA_VERSION });
    }

    async close() {
        await this._pool.end();
    }

    /**
     * Idempotent column additions via information_schema lookups.
     * Safe on fresh DBs (CREATE TABLE above already includes everything)
     * and on any DB that pre-dates newer columns.
     */
    async _runMigrations(client) {
        const colsRes = await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
            ['positions']
        );
        const existing = new Set(colsRes.rows.map((r) => r.column_name));

        const ensureColumn = async (col, typeDecl) => {
            if (!existing.has(col)) {
                await client.query(`ALTER TABLE positions ADD COLUMN ${col} ${typeDecl}`);
                logger.info(`[DatabasePg] migration: added positions.${col}`);
            }
        };

        await ensureColumn('sl_order_id', 'TEXT');
        await ensureColumn('tp1_order_id', 'TEXT');
        await ensureColumn('tp2_order_id', 'TEXT');
        await ensureColumn('tp3_order_id', 'TEXT');
        await ensureColumn('user_id', 'TEXT');
    }

    async _ensureSchemaVersion(client) {
        const res = await client.query(
            'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
        );
        const current = res.rows[0]?.version;
        if (current !== SCHEMA_VERSION) {
            await client.query(
                'INSERT INTO schema_version (version, applied_at) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
                [SCHEMA_VERSION, Date.now()]
            );
        }
    }

    // ─── Low-level accessors ────────────────────────────────────────────────

    async run(sql, params = []) {
        const pgSql = toPgPlaceholders(sql);
        try {
            await this._pool.query(pgSql, params);
        } catch (err) {
            logger.error('[DatabasePg] run failed', { message: err.message, sql: pgSql });
            throw err;
        }
    }

    async all(sql, params = []) {
        const pgSql = toPgPlaceholders(sql);
        try {
            const res = await this._pool.query(pgSql, params);
            return res.rows;
        } catch (err) {
            logger.error('[DatabasePg] all failed', { message: err.message, sql: pgSql });
            throw err;
        }
    }

    async get(sql, params = []) {
        const rows = await this.all(sql, params);
        return rows[0] || null;
    }

    // ─── Positions ──────────────────────────────────────────────────────────

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

    async insertPartialClose(pc) {
        await this.run(
            `INSERT INTO partial_closes (position_id, tp_level, price, quantity, pnl, order_id, closed_at)
             VALUES (?,?,?,?,?,?,?)`,
            [pc.positionId, pc.tpLevel, pc.price, pc.quantity, pc.pnl, pc.orderId ?? null, pc.closedAt]
        );
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

    // ─── KV ─────────────────────────────────────────────────────────────────

    async kvGet(key) {
        const row = await this.get('SELECT value FROM kv_store WHERE key=?', [key]);
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
    }

    async kvSet(key, value) {
        await this.run(
            `INSERT INTO kv_store (key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
            [key, JSON.stringify(value), Date.now()]
        );
    }

    // ─── Stats ──────────────────────────────────────────────────────────────

    async getDailyStats(userId) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const startTs = todayStart.getTime();

        let sql = `
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
                COALESCE(SUM(realized_pnl), 0) AS total_pnl
            FROM positions
            WHERE status = 'CLOSED' AND closed_at >= ?`;
        const params = [startTs];
        if (userId) {
            sql += ` AND user_id = ?`;
            params.push(userId);
        }

        const row = await this.get(sql, params);
        if (!row) return null;

        const total = Number(row.total) || 0;
        const wins = Number(row.wins) || 0;
        const losses = Number(row.losses) || 0;
        const totalPnl = Number(row.total_pnl) || 0;
        return {
            totalTrades: total,
            winTrades: wins,
            lossTrades: losses,
            totalPnl,
            winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
            closedTrades: total
        };
    }

    // ─── User CRUD ──────────────────────────────────────────────────────────

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
            'risk_leverage', 'risk_position_size_pct', 'symbols', 'username'
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
}

module.exports = { DatabasePg };
