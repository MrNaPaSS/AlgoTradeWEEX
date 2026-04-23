const logger = require('../utils/logger');

/**
 * Database factory — returns a PostgreSQL adapter when `DATABASE_URL` is set,
 * otherwise the local sql.js-backed `Database`.
 *
 * Both adapters expose the same async interface (see Database / DatabasePg).
 * This keeps call-sites storage-agnostic: the same `src/app.js` and
 * `src/web.js` work against SQLite (local VPS) and PostgreSQL (render.com).
 */
function createDatabase() {
    if (process.env.DATABASE_URL) {
        const { DatabasePg } = require('./DatabasePg');
        logger.info('[createDatabase] using PostgreSQL (DATABASE_URL is set)');
        return new DatabasePg(process.env.DATABASE_URL);
    }

    const { Database } = require('./database');
    logger.info('[createDatabase] using local SQLite (sql.js)');
    return new Database();
}

module.exports = { createDatabase };
