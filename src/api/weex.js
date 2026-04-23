const axios = require('axios');
const https = require('https');
const config = require('../config/config');
const WeexSignature = require('../utils/signature');
const logger = require('../utils/logger');

/**
 * WEEX API клиент для спотовой торговли
 */
class WeexClient {
    constructor() {
        this.baseUrl = config.weex.baseUrl;
        this.apiKey = config.weex.apiKey;
        this.secretKey = config.weex.secretKey;
        this.passphrase = config.weex.passphrase;
        this.signature = new WeexSignature(this.secretKey);

        // Создаём HTTPS агент с настройками TLS
        const httpsAgent = new https.Agent({
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2'
        });

        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 15000,
            httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'Sec-Fetch-Dest': 'empty',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Site': 'cross-site'
            }
        });
    }

    /**
     * Выполнить приватный GET запрос
     */
    async privateGet(path, params = {}) {
        const queryString = Object.keys(params).length
            ? '?' + new URLSearchParams(params).toString()
            : '';
        const fullPath = path + queryString;

        const headers = this.signature.getHeaders(
            this.apiKey,
            this.passphrase,
            'GET',
            fullPath
        );

        try {
            const response = await this.client.get(fullPath, { headers });
            return response.data;
        } catch (error) {
            this.handleError('GET', fullPath, error);
        }
    }

    /**
     * Выполнить приватный POST запрос
     */
    async privatePost(path, data = {}) {
        const body = JSON.stringify(data);

        const headers = this.signature.getHeaders(
            this.apiKey,
            this.passphrase,
            'POST',
            path,
            body
        );

        try {
            const response = await this.client.post(path, data, { headers });
            return response.data;
        } catch (error) {
            this.handleError('POST', path, error);
        }
    }

    /**
     * Выполнить публичный GET запрос
     */
    async publicGet(path, params = {}) {
        try {
            const response = await this.client.get(path, { params });
            return response.data;
        } catch (error) {
            this.handleError('GET', path, error);
        }
    }

    /**
     * Обработка ошибок
     */
    handleError(method, path, error) {
        const errorMessage = error.response?.data?.msg || error.response?.data?.message || error.message || 'Неизвестная ошибка';
        const errorCode = error.response?.data?.code || error.response?.status || 'UNKNOWN';
        logger.error(`WEEX API ошибка [${method}] ${path}: ${errorMessage} (код: ${errorCode})`);

        // Создаём новую ошибку без циклических ссылок
        const cleanError = new Error(errorMessage);
        cleanError.code = errorCode;
        cleanError.path = path;
        throw cleanError;
    }

    // ============================================
    // АККАУНТ
    // ============================================

    /**
     * Получить баланс всех активов
     */
    async getAssets() {
        const response = await this.privateGet('/api/spot/v1/account/assets');
        return response.data;
    }

    /**
     * Получить баланс конкретного актива
     */
    async getBalance(coin) {
        const assets = await this.getAssets();
        const asset = assets.find(a => a.coinName === coin);

        if (!asset) {
            return { available: 0, frozen: 0, total: 0 };
        }

        return {
            available: parseFloat(asset.available),
            frozen: parseFloat(asset.frozen),
            total: parseFloat(asset.available) + parseFloat(asset.frozen)
        };
    }

    // ============================================
    // РЫНОЧНЫЕ ДАННЫЕ
    // ============================================

    /**
     * Получить тикер (текущую цену) для символа
     */
    async getTicker(symbol) {
        const response = await this.publicGet('/api/spot/v1/market/ticker', { symbol });
        const data = response.data;

        return {
            symbol: data.symbol,
            lastPrice: parseFloat(data.close),
            bidPrice: parseFloat(data.buyOne),
            askPrice: parseFloat(data.sellOne),
            high24h: parseFloat(data.high24h),
            low24h: parseFloat(data.low24h),
            volume24h: parseFloat(data.usdtVolume)
        };
    }

    // ============================================
    // ТОРГОВЛЯ
    // ============================================

    /**
     * Создать ордер
     */
    async createOrder(params) {
        const orderData = {
            symbol: params.symbol,
            side: params.side,
            orderType: params.orderType,
            force: 'normal',
            quantity: params.quantity.toString()
        };

        if (params.orderType === 'limit' && params.price) {
            orderData.price = params.price.toString();
        }

        if (params.clientOrderId) {
            orderData.clientOrderId = params.clientOrderId;
        }

        logger.info('Создание ордера:', orderData);

        const response = await this.privatePost('/api/spot/v1/trade/orders', orderData);

        logger.info('Ордер создан:', response.data);

        return {
            orderId: response.data.orderId,
            clientOrderId: response.data.clientOrderId,
            status: 'created'
        };
    }

    async marketBuy(symbol, quantity) {
        return this.createOrder({
            symbol,
            side: 'buy',
            orderType: 'market',
            quantity
        });
    }

    async marketSell(symbol, quantity) {
        return this.createOrder({
            symbol,
            side: 'sell',
            orderType: 'market',
            quantity
        });
    }

    async limitBuy(symbol, quantity, price) {
        return this.createOrder({
            symbol,
            side: 'buy',
            orderType: 'limit',
            quantity,
            price
        });
    }

    async limitSell(symbol, quantity, price) {
        return this.createOrder({
            symbol,
            side: 'sell',
            orderType: 'limit',
            quantity,
            price
        });
    }

    async cancelOrder(symbol, orderId) {
        const response = await this.privatePost('/api/spot/v1/trade/cancel-order', {
            symbol,
            orderId
        });

        logger.info('Ордер отменён:', { symbol, orderId });

        return response.data;
    }

    async cancelAllOrders(symbol) {
        const response = await this.privatePost('/api/spot/v1/trade/cancel-orders', {
            symbol
        });

        logger.info('Все ордера отменены:', { symbol });

        return response.data;
    }

    async getOpenOrders(symbol) {
        const response = await this.privateGet('/api/spot/v1/trade/open-orders', { symbol });
        return response.data || [];
    }

    async getOrder(symbol, orderId) {
        const response = await this.privateGet('/api/spot/v1/trade/order', {
            symbol,
            orderId
        });
        return response.data;
    }

    async getOrderHistory(symbol, limit = 50) {
        const response = await this.privateGet('/api/spot/v1/trade/history', {
            symbol,
            limit
        });
        return response.data || [];
    }
}

module.exports = WeexClient;
