const crypto = require('crypto');

/**
 * WEEX API signature helper (HMAC-SHA256, Base64).
 *
 * Per official WEEX API docs:
 *   Message = timestamp + METHOD + requestPath + queryString + body
 *
 *   Where:
 *     timestamp   — Unix ms as string (e.g. "1713400000000")
 *     METHOD      — uppercase HTTP method ("GET", "POST", "DELETE")
 *     requestPath — path WITHOUT query string (e.g. "/capi/v3/order")
 *     queryString — URL-encoded query params string WITHOUT leading '?'
 *                   (empty string "" if no params)
 *     body        — raw JSON body string (empty string "" if no body)
 *
 * Required headers:
 *   ACCESS-KEY        — API key
 *   ACCESS-SIGN       — Base64(HMAC-SHA256(message, secretKey))
 *   ACCESS-TIMESTAMP  — Unix ms timestamp string
 *   ACCESS-PASSPHRASE — Passphrase set when creating API key
 *   Content-Type      — application/json
 */
class WeexSignature {
    constructor(secretKey) {
        if (!secretKey) throw new Error('[WeexSignature] secretKey is required');
        this._secretKey = secretKey;
    }

    /**
     * Build signature string.
     * @param {string} timestamp   — ms since epoch as string
     * @param {string} method      — 'GET' | 'POST' | 'DELETE'
     * @param {string} requestPath — path only, e.g. '/capi/v3/order'
     * @param {string} [queryString] — URL-encoded query params (no '?'), empty if none
     * @param {string} [body]      — JSON body string, empty if none
     */
    sign(timestamp, method, requestPath, queryString = '', body = '') {
        const query = queryString ? '?' + queryString : '';
        const message = `${timestamp}${method.toUpperCase()}${requestPath}${query}${body}`;
        return crypto
            .createHmac('sha256', this._secretKey)
            .update(message)
            .digest('base64');
    }

    /**
     * Build all required auth headers for a request.
     * @param {Object} opts
     * @param {string} opts.apiKey
     * @param {string} opts.passphrase
     * @param {string} opts.method
     * @param {string} opts.requestPath
     * @param {string} [opts.queryString]
     * @param {string} [opts.body]
     */
    buildHeaders({ apiKey, passphrase, method, requestPath, queryString = '', body = '' }) {
        const timestamp = Date.now().toString();
        const sign = this.sign(timestamp, method, requestPath, queryString, body);
        return {
            'ACCESS-KEY':        apiKey,
            'ACCESS-SIGN':       sign,
            'ACCESS-TIMESTAMP':  timestamp,
            'ACCESS-PASSPHRASE': passphrase,
            'Content-Type':      'application/json'
        };
    }
}

module.exports = { WeexSignature };
