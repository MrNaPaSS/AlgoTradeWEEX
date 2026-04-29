/**
 * Integration tests: webhook → forum signal broadcast
 *
 * Covers:
 *  - EXECUTE decision triggers notifySignalToForum()
 *  - HOLD decision does NOT trigger notifySignalToForum()
 *  - REJECT decision does NOT trigger notifySignalToForum()
 *  - forum notify failure does not affect HTTP 200 response
 *  - notifySignalToForum receives correct signal + decision objects
 */

'use strict';

jest.mock('../../src/config/config', () => ({
    webhook: {
        hmacRequired: false,
        hmacSecret: '',
        secret: 'test-secret',
        idempotencyTtlSeconds: 60,
        replayWindowSeconds: 300,
        rateLimitPerMinute: 100
    },
    telegram: {
        botToken: 'tok',
        chatId: '111',
        forumChatId: '-1003567202226',
        forumTopicId: 10,
        isConfigured: true,
        isForumConfigured: true
    },
    server: { logLevel: 'error' },
    isProd: false
}));

jest.mock('../../src/utils/logger', () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const express  = require('express');
const request  = require('supertest');
const { createWebhookRouter } = require('../../src/routes/webhook');

// ── Helpers ───────────────────────────────────────────────────────────────────
const makePayload = (overrides = {}) => ({
    secret: 'test-secret',
    signalType: 'CE_BUY',
    symbol: 'BTCUSDT',
    tf: '1h',
    price: 42500,
    longStop: 41000,
    ...overrides
});

const makeTelegram = () => ({
    notifySignalToForum: jest.fn().mockResolvedValue(undefined),
    notifyDecision:      jest.fn().mockResolvedValue(undefined)
});

const makeOrchestrator = (outcome = 'EXECUTE') => ({
    handleSignal: jest.fn().mockResolvedValue({
        id: 'dec-1',
        outcome,
        direction: 'LONG',
        confidence: 0.8,
        risk: {
            sizing: {
                stopLoss: 41000,
                takeProfits: [
                    { level: 1, price: 43500, closePercent: 50 },
                    { level: 2, price: 44500, closePercent: 30 },
                    { level: 3, price: 46000, closePercent: 20 }
                ]
            }
        }
    })
});

const buildApp = (orchestrator, telegram) => {
    const app = express();
    app.use('/webhook', createWebhookRouter({ orchestrator, telegram }));
    return app;
};

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('Webhook → Forum broadcast', () => {
    test('EXECUTE decision calls notifySignalToForum once', async () => {
        const telegram    = makeTelegram();
        const orchestrator = makeOrchestrator('EXECUTE');
        const app = buildApp(orchestrator, telegram);

        const res = await request(app).post('/webhook').send(makePayload());

        expect(res.status).toBe(200);
        expect(telegram.notifySignalToForum).toHaveBeenCalledTimes(1);

        // Verify signal argument
        const [signal, decision] = telegram.notifySignalToForum.mock.calls[0];
        expect(signal.symbol).toBe('BTCUSDT');
        expect(signal.tf).toBe('1h');
        expect(signal.price).toBe(42500);

        // Verify decision argument
        expect(decision.outcome).toBe('EXECUTE');
        expect(decision.direction).toBe('LONG');
    });

    test('HOLD decision does NOT call notifySignalToForum', async () => {
        const telegram    = makeTelegram();
        const orchestrator = makeOrchestrator('HOLD');
        const app = buildApp(orchestrator, telegram);

        const res = await request(app).post('/webhook').send(makePayload());

        expect(res.status).toBe(200);
        expect(telegram.notifySignalToForum).not.toHaveBeenCalled();
    });

    test('REJECT decision does NOT call notifySignalToForum', async () => {
        const telegram    = makeTelegram();
        const orchestrator = makeOrchestrator('REJECT');
        const app = buildApp(orchestrator, telegram);

        const res = await request(app).post('/webhook').send(makePayload());

        expect(res.status).toBe(200);
        expect(telegram.notifySignalToForum).not.toHaveBeenCalled();
    });

    test('forum notify failure does not affect 200 response', async () => {
        const telegram    = makeTelegram();
        telegram.notifySignalToForum.mockRejectedValue(new Error('Telegram down'));
        const orchestrator = makeOrchestrator('EXECUTE');
        const app = buildApp(orchestrator, telegram);

        const res = await request(app).post('/webhook').send(makePayload());

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.outcome).toBe('EXECUTE');
    });

    test('notifyDecision is still called alongside forum broadcast on EXECUTE', async () => {
        const telegram    = makeTelegram();
        const orchestrator = makeOrchestrator('EXECUTE');
        const app = buildApp(orchestrator, telegram);

        await request(app).post('/webhook').send(makePayload());

        expect(telegram.notifySignalToForum).toHaveBeenCalledTimes(1);
        expect(telegram.notifyDecision).toHaveBeenCalledTimes(1);
    });

    test('notifySignalToForum not called when telegram is undefined', async () => {
        const orchestrator = makeOrchestrator('EXECUTE');
        const app = buildApp(orchestrator, undefined);

        const res = await request(app).post('/webhook').send(makePayload());

        expect(res.status).toBe(200);
        // No crash — just no forum call
    });
});
