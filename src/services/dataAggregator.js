const EventEmitter = require('events');
const { RingBuffer } = require('../utils/ringBuffer');
const logger = require('../utils/logger');

const BUFFER_CAPACITY = 500;

/**
 * DataAggregator maintains a per-(symbol, tf) ring buffer of candles.
 * Fed by WebSocket kline events; exposes `getCandles(symbol, tf)` to agents.
 *
 * Events:
 *   'candleClosed' — { symbol, tf, candle } (emitted once a bar closes)
 *   'candleUpdated'— { symbol, tf, candle } (in-progress bar update)
 */
class DataAggregator extends EventEmitter {
    constructor({ capacity = BUFFER_CAPACITY } = {}) {
        super();
        this._capacity = capacity;
        /** @type {Map<string, RingBuffer>} */
        this._buffers = new Map();
    }

    _key(symbol, tf) {
        return `${symbol.toUpperCase()}:${tf}`;
    }

    _getBuffer(symbol, tf) {
        const key = this._key(symbol, tf);
        let buf = this._buffers.get(key);
        if (!buf) {
            buf = new RingBuffer(this._capacity);
            this._buffers.set(key, buf);
        }
        return buf;
    }

    /** Seed a fresh buffer with historical candles (oldest → newest). */
    seedHistorical(symbol, tf, candles) {
        const buf = this._getBuffer(symbol, tf);
        buf.clear();
        buf.pushMany(candles);
        logger.info(`[DataAggregator] seeded ${symbol}:${tf}`, { count: candles.length });
    }

    /**
     * Ingest a streaming candle. If the candle timestamp matches the last stored
     * timestamp we replace (in-progress update); otherwise append and emit close.
     */
    ingestCandle(symbol, tf, candle) {
        const buf = this._getBuffer(symbol, tf);
        const last = buf.last();
        if (last && last.timestamp === candle.timestamp) {
            buf.replaceLast(candle);
            this.emit('candleUpdated', { symbol, tf, candle });
        } else {
            buf.push(candle);
            this.emit('candleClosed', { symbol, tf, candle });
        }
    }

    getCandles(symbol, tf) {
        return this._getBuffer(symbol, tf).toArray();
    }

    hasEnoughData(symbol, tf, minCount = 60) {
        return this._getBuffer(symbol, tf).size >= minCount;
    }
}

module.exports = { DataAggregator };
