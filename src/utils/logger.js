const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const winston = require('winston');

const config = require('../config/config');

const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const asyncContext = new AsyncLocalStorage();

const contextFormat = winston.format((info) => {
    const store = asyncContext.getStore();
    if (store) {
        for (const [k, v] of Object.entries(store)) {
            if (info[k] === undefined) info[k] = v;
        }
    }
    return info;
});

/** Redacts sensitive fields from meta and messages */
const secrets = [
    config.weex?.secretKey,
    config.weex?.passphrase,
    config.openRouter?.apiKey,
    config.telegram?.token,
    config.webhook?.hmacSecret
].filter(val => val && val.length > 5 && val !== 'change_me' && val !== 'change_me_too_for_signature_validation');

const scrubFormat = winston.format((info) => {
    const scrub = (val) => {
        if (typeof val !== 'string') return val;
        let result = val;
        for (const secret of secrets) {
            result = result.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
        }
        return result;
    };

    // Scrub message
    info.message = scrub(info.message);

    // Scrub meta
    for (const key of Object.keys(info)) {
        if (['message', 'level', 'timestamp', 'requestId', 'symbol', 'phase', 'stack'].includes(key)) continue;
        if (typeof info[key] === 'string') {
            info[key] = scrub(info[key]);
        } else if (typeof info[key] === 'object' && info[key] !== null) {
            try {
                const str = JSON.stringify(info[key]);
                let scrubbed = str;
                for (const secret of secrets) {
                    scrubbed = scrubbed.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
                }
                info[key] = JSON.parse(scrubbed);
            } catch {
                // fallback if not serializable
            }
        }
    }
    return info;
});

const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    contextFormat(),
    winston.format.errors({ stack: true }),
    winston.format.colorize({ all: false, level: true }),
    winston.format.printf(({ timestamp, level, message, requestId, symbol, phase, stack, ...meta }) => {
        const ctx = [
            requestId ? `rid=${requestId}` : null,
            symbol ? `sym=${symbol}` : null,
            phase ? `phase=${phase}` : null
        ]
            .filter(Boolean)
            .join(' ');
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `[${timestamp}] ${level} ${ctx ? `(${ctx}) ` : ''}${message}${metaStr}${stackStr}`;
    })
);

const fileFormat = winston.format.combine(
    winston.format.timestamp(),
    contextFormat(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const logger = winston.createLogger({
    level: config.server.logLevel,
    format: winston.format.combine(
        scrubFormat(),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({ format: consoleFormat, handleExceptions: false }),
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: fileFormat,
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: fileFormat,
            maxsize: 20 * 1024 * 1024,
            maxFiles: 10
        })
    ],
    exitOnError: false
});

function runWithContext(ctx, fn) {
    return asyncContext.run({ ...ctx }, fn);
}

function setContext(partial) {
    const store = asyncContext.getStore();
    if (store) Object.assign(store, partial);
}

function getContext() {
    return asyncContext.getStore() || {};
}

function child(bindings) {
    return {
        error: (msg, meta = {}) => logger.error(msg, { ...bindings, ...meta }),
        warn: (msg, meta = {}) => logger.warn(msg, { ...bindings, ...meta }),
        info: (msg, meta = {}) => logger.info(msg, { ...bindings, ...meta }),
        debug: (msg, meta = {}) => logger.debug(msg, { ...bindings, ...meta })
    };
}

module.exports = logger;
module.exports.runWithContext = runWithContext;
module.exports.setContext = setContext;
module.exports.getContext = getContext;
module.exports.child = child;
