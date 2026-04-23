const crypto = require('crypto');

/**
 * Генерация HMAC SHA256 подписи для WEEX API
 */
class WeexSignature {
    constructor(secretKey) {
        this.secretKey = secretKey;
    }

    /**
     * Создать подпись для запроса
     */
    sign(timestamp, method, requestPath, body = '') {
        const message = timestamp + method.toUpperCase() + requestPath + body;

        const signature = crypto
            .createHmac('sha256', this.secretKey)
            .update(message)
            .digest('base64');

        return signature;
    }

    /**
     * Получить заголовки для авторизованного запроса
     */
    getHeaders(apiKey, passphrase, method, requestPath, body = '') {
        const timestamp = Date.now().toString();
        const signature = this.sign(timestamp, method, requestPath, body);

        return {
            'ACCESS-KEY': apiKey,
            'ACCESS-SIGN': signature,
            'ACCESS-TIMESTAMP': timestamp,
            'ACCESS-PASSPHRASE': passphrase,
            'Content-Type': 'application/json'
        };
    }
}

module.exports = WeexSignature;
