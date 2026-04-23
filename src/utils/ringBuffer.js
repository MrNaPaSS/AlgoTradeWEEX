/**
 * Fixed-capacity circular buffer for time-series data (OHLCV candles).
 * O(1) push, O(n) toArray. Most-recent-last ordering.
 */
class RingBuffer {
    constructor(capacity) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
            throw new RangeError('[RingBuffer] capacity must be a positive integer');
        }
        this._capacity = capacity;
        this._buffer = new Array(capacity);
        this._head = 0;
        this._size = 0;
    }

    push(item) {
        this._buffer[this._head] = item;
        this._head = (this._head + 1) % this._capacity;
        if (this._size < this._capacity) this._size += 1;
    }

    pushMany(items) {
        for (const item of items) this.push(item);
    }

    /** Replace the most recently pushed item (useful for streaming last candle). */
    replaceLast(item) {
        if (this._size === 0) {
            this.push(item);
            return;
        }
        const lastIdx = (this._head - 1 + this._capacity) % this._capacity;
        this._buffer[lastIdx] = item;
    }

    last() {
        if (this._size === 0) return undefined;
        const lastIdx = (this._head - 1 + this._capacity) % this._capacity;
        return this._buffer[lastIdx];
    }

    get size() {
        return this._size;
    }

    get capacity() {
        return this._capacity;
    }

    /** Returns a plain array ordered oldest→newest. */
    toArray() {
        if (this._size === 0) return [];
        const out = new Array(this._size);
        const start = this._size < this._capacity ? 0 : this._head;
        for (let i = 0; i < this._size; i += 1) {
            out[i] = this._buffer[(start + i) % this._capacity];
        }
        return out;
    }

    clear() {
        this._buffer = new Array(this._capacity);
        this._head = 0;
        this._size = 0;
    }
}

module.exports = { RingBuffer };
