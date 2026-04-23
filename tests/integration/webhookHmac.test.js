const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { createWebhookRouter } = require('../../src/routes/webhook');

// Mock config to enable HMAC
jest.mock('../../src/config/config', () => ({
    webhook: {
        hmacRequired: true,
        hmacSecret: 'test-hmac-secret',
        secret: 'test-webhook-secret',
        idempotencyTtlSeconds: 60,
        replayWindowSeconds: 300
    },
    server: {
        logLevel: 'info'
    },
    weex: {
        apiKey: 'test-key',
        secretKey: 'test-secret',
        passphrase: 'test-passphrase'
    },
    openRouter: {
        apiKey: 'test-or-key'
    },
    telegram: {
        token: 'test-tg-token'
    },
    isProd: false
}));

describe('Integration: Webhook HMAC & Idempotency', () => {
    let app;
    let mockOrchestrator;
    const HMAC_SECRET = 'test-hmac-secret';
    const WEBHOOK_SECRET = 'test-webhook-secret';

    beforeEach(() => {
        mockOrchestrator = {
            handleSignal: jest.fn().mockResolvedValue({ id: 'dec-123', outcome: 'EXECUTE', direction: 'LONG' })
        };
        app = express();
        // Do NOT use app.use(express.json()) here, 
        // because createWebhookRouter adds its own with 'verify' to stash raw body.
        app.use('/webhook', createWebhookRouter({ orchestrator: mockOrchestrator }));
    });

    const computeHmac = (payload, timestamp, secret) => {
        const data = `${timestamp}.${payload}`;
        return crypto.createHmac('sha256', secret).update(data).digest('hex');
    };

    test('Valid signature + fresh timestamp -> 200 OK', async () => {
        const payload = { 
            secret: WEBHOOK_SECRET, 
            signalType: 'CE_BUY', 
            symbol: 'BTCUSDT', 
            tf: '1h', 
            price: 50000,
            timestamp: Date.now() // signal timestamp (not used for HMAC)
        };
        const rawBody = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = computeHmac(rawBody, timestamp, HMAC_SECRET);

        const res = await request(app)
            .post('/webhook')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.outcome).toBe('EXECUTE');
    });

    test('Stale timestamp (> 300s ago) -> 401 Unauthorized', async () => {
        const payload = { secret: WEBHOOK_SECRET, signalType: 'CE_BUY', symbol: 'BTCUSDT', tf: '1h', price: 50000 };
        const rawBody = JSON.stringify(payload);
        const timestamp = Math.floor(Date.now() / 1000) - 400; // 400s ago
        const signature = computeHmac(rawBody, timestamp, HMAC_SECRET);

        const res = await request(app)
            .post('/webhook')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res.status).toBe(401);
        expect(res.body.error).toContain('timestamp outside replay window');
    });

    test('Invalid HMAC signature -> 401 Unauthorized', async () => {
        const payload = { secret: WEBHOOK_SECRET, signalType: 'CE_BUY', symbol: 'BTCUSDT', tf: '1h', price: 50000 };
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = 'wrong-signature';

        const res = await request(app)
            .post('/webhook')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid hmac signature');
    });

    test('Missing x-timestamp header -> 401 Unauthorized', async () => {
        const payload = { secret: WEBHOOK_SECRET, signalType: 'CE_BUY', symbol: 'BTCUSDT', tf: '1h', price: 50000 };
        
        const res = await request(app)
            .post('/webhook')
            .set('x-signature', 'some-sig')
            .send(payload);

        expect(res.status).toBe(401);
        expect(res.body.error).toContain('missing x-timestamp');
    });

    test('Duplicate signalId -> returns cached response with duplicate: true', async () => {
        const payload = { 
            id: 'test-id-123',
            secret: WEBHOOK_SECRET, 
            signalType: 'CE_BUY', 
            symbol: 'BTCUSDT', 
            tf: '1h', 
            price: 50000
        };
        const rawBody = JSON.stringify(payload);
        
        // First request
        let timestamp = Math.floor(Date.now() / 1000);
        let signature = computeHmac(rawBody, timestamp, HMAC_SECRET);
        const res1 = await request(app)
            .post('/webhook')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res1.status).toBe(200);
        expect(res1.body.duplicate).toBeUndefined();

        // Second request (immediate duplicate)
        timestamp = Math.floor(Date.now() / 1000);
        signature = computeHmac(rawBody, timestamp, HMAC_SECRET);
        const res2 = await request(app)
            .post('/webhook')
            .set('x-timestamp', timestamp.toString())
            .set('x-signature', signature)
            .send(payload);

        expect(res2.status).toBe(200);
        expect(res2.body.duplicate).toBe(true);
        expect(res2.body.decisionId).toBe(res1.body.decisionId);
        expect(mockOrchestrator.handleSignal).toHaveBeenCalledTimes(1);
    });

    test('Legacy path: HMAC NOT required -> works with secret only', async () => {
        // Re-create app with mock config change
        jest.resetModules();
        jest.mock('../../src/config/config', () => ({
            webhook: {
                hmacRequired: false,
                hmacSecret: '', // Not configured
                secret: 'legacy-secret'
            },
            server: {
                logLevel: 'info'
            },
            isProd: false
        }));
        const { createWebhookRouter: createLegacyRouter } = require('../../src/routes/webhook');
        const legacyApp = express();
        legacyApp.use(express.json());
        legacyApp.use('/webhook', createLegacyRouter({ orchestrator: mockOrchestrator }));

        const payload = { secret: 'legacy-secret', signalType: 'BM_LONG', symbol: 'BTCUSDT', tf: '1h', price: 50000 };
        
        const res = await request(legacyApp)
            .post('/webhook')
            .send(payload);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
