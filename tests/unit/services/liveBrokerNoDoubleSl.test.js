/**
 * Fix regression: no double SL on position open.
 *
 * placeMarketOrder must NOT include slTriggerPrice / tpTriggerPrice in the
 * placeOrder call. The SL is attached exclusively via _attachSlWithRetry →
 * placeTpSlOrder. Including those fields caused WEEX to create a second SL
 * order alongside the one placed by _attachSlWithRetry.
 */

const { LiveBroker } = require('../../../src/services/LiveBroker');

jest.mock('../../../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Stub the metrics module — it is optional but loaded at module level.
jest.mock('../../../src/routes/metrics', () => ({ metrics: {} }), { virtual: true });

function makeClient(overrides = {}) {
    return {
        setLeverage: jest.fn().mockResolvedValue({}),
        placeOrder: jest.fn().mockResolvedValue({ orderId: 'entry-ord-1', data: {} }),
        // placeTpSlOrder returns the shape _parseTpSlOrderId expects.
        placeTpSlOrder: jest.fn().mockResolvedValue([{ success: true, orderId: '123' }]),
        modifyTpSlOrder: jest.fn(),
        cancelOrder: jest.fn(),
        getPositions: jest.fn().mockResolvedValue([]),
        cancelAllForSymbol: jest.fn().mockResolvedValue({}),
        getUserTrades: jest.fn().mockResolvedValue([]),
        ...overrides
    };
}

describe('LiveBroker.placeMarketOrder — no double SL', () => {
    test('placeOrder is called WITHOUT slTriggerPrice when stopLoss is provided', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5,
            stopLoss: 1900
        });

        expect(client.placeOrder).toHaveBeenCalledTimes(1);
        const orderArg = client.placeOrder.mock.calls[0][0];
        expect(orderArg).not.toHaveProperty('slTriggerPrice');
    });

    test('placeOrder is called WITHOUT tpTriggerPrice when tpPrice is provided', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5,
            stopLoss: 1900,
            tpPrice: 2100
        });

        expect(client.placeOrder).toHaveBeenCalledTimes(1);
        const orderArg = client.placeOrder.mock.calls[0][0];
        expect(orderArg).not.toHaveProperty('tpTriggerPrice');
    });

    test('placeTpSlOrder is called exactly once for SL attach (no duplicate)', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5,
            stopLoss: 1900
        });

        // Only one STOP_LOSS plan order — from _attachSlWithRetry.
        const slCalls = client.placeTpSlOrder.mock.calls.filter(
            ([arg]) => arg.planType === 'STOP_LOSS'
        );
        expect(slCalls).toHaveLength(1);
    });

    test('result contains slOrderId returned by placeTpSlOrder', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        const result = await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5,
            stopLoss: 1900
        });

        expect(result.slOrderId).toBe('123');
    });

    test('no SL call when stopLoss is omitted', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        const result = await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5
        });

        expect(client.placeTpSlOrder).not.toHaveBeenCalled();
        expect(result.slOrderId).toBeNull();
    });

    test('placeOrder contains required fields: symbol, side, positionSide, orderType, quantity', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'long',
            quantity: 1,
            price: 2000,
            leverage: 5,
            stopLoss: 1900
        });

        const orderArg = client.placeOrder.mock.calls[0][0];
        expect(orderArg).toMatchObject({
            symbol: 'ETHUSDT',
            quantity: 1
        });
        expect(orderArg).toHaveProperty('side');
        expect(orderArg).toHaveProperty('positionSide');
        expect(orderArg).toHaveProperty('orderType');
    });

    test('SHORT side maps correctly and SL still attached once', async () => {
        const client = makeClient();
        const broker = new LiveBroker({ client });

        await broker.placeMarketOrder({
            symbol: 'ETHUSDT',
            side: 'short',
            quantity: 0.5,
            price: 2000,
            leverage: 10,
            stopLoss: 2100
        });

        expect(client.placeOrder).toHaveBeenCalledTimes(1);
        const orderArg = client.placeOrder.mock.calls[0][0];
        expect(orderArg).not.toHaveProperty('slTriggerPrice');
        expect(orderArg).not.toHaveProperty('tpTriggerPrice');

        const slCalls = client.placeTpSlOrder.mock.calls.filter(
            ([arg]) => arg.planType === 'STOP_LOSS'
        );
        expect(slCalls).toHaveLength(1);
    });
});
