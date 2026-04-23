const EventEmitter = require('events');
const WebSocket = require('ws');

const logger = require('../../utils/logger');
const { BASE_URL_WS_PUB, BASE_URL_WS_PRIV, toKlineChannel } = require('./endpoints');

const PING_INTERVAL_MS         = 20_000;
const RECONNECT_INITIAL_DELAY  = 1_000;
const RECONNECT_MAX_DELAY      = 30_000;

/**
 * WEEX Futures WebSocket client.
 *
 * Based on official docs: https://www.weex.com/api-doc (Futures → WebSocket)
 *
 * Public  URL:  wss://ws-contract.weex.com/v3/ws/public
 * Private URL:  wss://ws-contract.weex.com/v3/ws/private
 *
 * Subscribe format:
 *   { "method": "SUBSCRIBE", "params": ["BTCUSDT@kline_1h"], "id": 1 }
 *
 * Server heartbeat:
 *   Server sends: { "event": "ping" }
 *   Client must respond: { "method": "PONG", "id": 1 }
 *
 * Kline channel: <SYMBOL>@kline_<interval>  e.g. BTCUSDT@kline_1h
 * Ticker channel: <SYMBOL>@ticker
 * Depth channel:  <SYMBOL>@depth<level>   e.g. BTCUSDT@depth15
 *
 * Emits:
 *   'open'     — connection ready
 *   'close'    — socket closed
 *   'error'    — transport error
 *   'kline'    — { symbol, tf, candle: {timestamp,open,high,low,close,volume} }
 *   'ticker'   — { symbol, data }
 *   'raw'      — original parsed message (debug)
 */
class WeexWebSocket extends EventEmitter {
    /**
     * @param {Object} [opts]
     * @param {string} [opts.url]   — override WS URL (defaults to public)
     * @param {boolean} [opts.private] — use private URL
     */
    constructor({ url, private: isPrivate = false } = {}) {
        super();
        this._url = url || (isPrivate ? BASE_URL_WS_PRIV : BASE_URL_WS_PUB);
        this._ws = null;
        /** @type {Map<string, string>} channel → subscription param string */
        this._subscriptions = new Map();
        this._pingTimer = null;
        this._reconnectDelay = RECONNECT_INITIAL_DELAY;
        this._closedByUser = false;
        this._msgId = 1;
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    connect() {
        this._closedByUser = false;
        this._open();
    }

    close() {
        this._closedByUser = true;
        this._clearPing();
        if (this._ws) {
            try { this._ws.close(); } catch { /* ignore */ }
            this._ws = null;
        }
    }

    /**
     * Subscribe to kline channel for a symbol and timeframe.
     * Channel format: BTCUSDT@kline_1h
     */
    subscribeKline(symbol, tf) {
        const channel = toKlineChannel(symbol, tf);
        this._subscribe(channel);
        // Store mapping for re-subscribe after reconnect
        this._subscriptions.set(channel, channel);
    }

    /** Subscribe to ticker channel: BTCUSDT@ticker */
    subscribeTicker(symbol) {
        const channel = `${symbol.toUpperCase()}@ticker`;
        this._subscribe(channel);
        this._subscriptions.set(channel, channel);
    }

    /** Subscribe to depth channel: BTCUSDT@depth15 */
    subscribeDepth(symbol, level = 15) {
        const channel = `${symbol.toUpperCase()}@depth${level}`;
        this._subscribe(channel);
        this._subscriptions.set(channel, channel);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    _subscribe(channel) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._send({ method: 'SUBSCRIBE', params: [channel], id: this._msgId++ });
        }
    }

    _resubscribeAll() {
        const channels = [...this._subscriptions.values()];
        if (channels.length === 0) return;
        this._send({ method: 'SUBSCRIBE', params: channels, id: this._msgId++ });
    }

    _open() {
        logger.info('[WeexWS] connecting', { url: this._url });
        this._ws = new WebSocket(this._url, { 
            handshakeTimeout: 10_000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        this._ws.on('open', () => {
            logger.info('[WeexWS] connected');
            this._reconnectDelay = RECONNECT_INITIAL_DELAY;
            this._startPing();
            this._resubscribeAll();
            this.emit('open');
        });

        this._ws.on('message', (buf) => this._handleMessage(buf));

        this._ws.on('error', (err) => {
            logger.warn('[WeexWS] error', { message: err.message });
            this.emit('error', err);
        });

        this._ws.on('close', (code, reason) => {
            logger.warn('[WeexWS] closed', { code, reason: reason?.toString() });
            this._clearPing();
            this.emit('close', { code, reason });
            if (!this._closedByUser) this._scheduleReconnect();
        });
    }

    _scheduleReconnect() {
        const delay = this._reconnectDelay;
        this._reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY);
        logger.info(`[WeexWS] reconnect in ${delay}ms`);
        setTimeout(() => { if (!this._closedByUser) this._open(); }, delay);
    }

    _startPing() {
        this._clearPing();
        this._pingTimer = setInterval(() => {
            if (this._ws?.readyState === WebSocket.OPEN) {
                try { 
                    this._ws.ping();
                } catch { /* ignore */ }
            }
        }, PING_INTERVAL_MS);
    }

    _clearPing() {
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = null;
    }

    _send(obj) {
        if (this._ws?.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    _handleMessage(buf) {
        const text = buf.toString('utf8');

        // Handle plain text pong
        if (text === 'pong') return;

        let payload;
        try {
            payload = JSON.parse(text);
        } catch {
            return;
        }

        this.emit('raw', payload);

        // Server ping — respond with PONG
        if (payload?.event === 'ping') {
            this._send({ method: 'PONG', id: this._msgId++ });
            return;
        }

        // Subscription confirmation
        if (payload?.result !== undefined || payload?.event === 'subscribe') {
            logger.debug('[WeexWS] subscription ack', payload);
            return;
        }

        // Data message: { stream: 'BTCUSDT@kline_1h', data: {...} }
        const stream = payload?.stream || payload?.e;
        const data   = payload?.data || payload?.k || payload;

        if (!stream) return;

        const [symbolRaw, channelRaw] = stream.split('@');
        const symbol = symbolRaw?.toUpperCase();

        if (channelRaw?.startsWith('kline_')) {
            const interval = channelRaw.replace('kline_', '');
            const k = data?.k || data;
            if (!k) return;

            const candle = {
                timestamp: Number(k.t ?? k.T ?? k.openTime),
                open:      Number(k.o ?? k.open),
                high:      Number(k.h ?? k.high),
                low:       Number(k.l ?? k.low),
                close:     Number(k.c ?? k.close),
                volume:    Number(k.v ?? k.volume),
                isClosed:  Boolean(k.x ?? k.isClosed ?? true)
            };
            this.emit('kline', { symbol, interval, tf: interval, candle });

        } else if (channelRaw === 'ticker') {
            this.emit('ticker', { symbol, data });
        }
    }
}

module.exports = { WeexWebSocket };
