/**
 * Unit tests: TelegramService.notifySignalToForum()
 *
 * Covers:
 *  - message is sent to forumChatId with correct message_thread_id
 *  - formatted text contains direction, symbol, tf, price, SL, TPs, confidence
 *  - silent no-op when forum is not configured
 *  - silent no-op when bot is not initialised
 *  - errors from sendMessage are caught and logged (do not throw)
 *  - LONG uses 📈, SHORT uses 📉
 */

'use strict';

// ── Config mock ─────────────────────────────────────────────────────────────
const MOCK_CONFIG = {
    telegram: {
        botToken: 'test-token',
        chatId: '111',
        forumChatId: '-1003567202226',
        forumTopicId: 10,
        isConfigured: true,
        isForumConfigured: true
    }
};

jest.mock('../../../src/config/config', () => MOCK_CONFIG);
jest.mock('../../../src/utils/logger', () => ({
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../../src/i18n/telegram', () => ({
    t: (key) => key
}));
jest.mock('node-telegram-bot-api');

const TelegramBot     = require('node-telegram-bot-api');
const telegramService = require('../../../src/services/telegram');
const logger          = require('../../../src/utils/logger');

// ── Fixtures ─────────────────────────────────────────────────────────────────
const makeLongSignal = (overrides = {}) => ({
    symbol: 'BTCUSDT', tf: '1h', price: 42500,
    longStop: 41000, shortStop: null, ...overrides
});

const makeShortSignal = (overrides = {}) => ({
    symbol: 'XAUTUSDT', tf: '10m', price: 2650,
    longStop: null, shortStop: 2700, ...overrides
});

const makeLongDecision = (overrides = {}) => ({
    direction: 'LONG',
    outcome: 'EXECUTE',
    confidence: 0.78,
    risk: {
        sizing: {
            stopLoss: 41000,
            takeProfits: [
                { level: 1, price: 43500, closePercent: 50 },
                { level: 2, price: 44500, closePercent: 30 },
                { level: 3, price: 46000, closePercent: 20 }
            ]
        }
    },
    ...overrides
});

const makeShortDecision = (overrides = {}) => ({
    direction: 'SHORT',
    outcome: 'EXECUTE',
    confidence: 0.65,
    risk: {
        sizing: {
            stopLoss: 2700,
            takeProfits: [
                { level: 1, price: 2600, closePercent: 50 },
                { level: 2, price: 2550, closePercent: 30 },
                { level: 3, price: 2480, closePercent: 20 }
            ]
        }
    },
    ...overrides
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('TelegramService.notifySignalToForum', () => {
    let mockSendMessage;

    beforeEach(() => {
        jest.clearAllMocks();
        mockSendMessage = jest.fn().mockResolvedValue({});
        TelegramBot.mockImplementation(() => ({ sendMessage: mockSendMessage }));

        // Re-initialise bot on service singleton
        telegramService.bot = { sendMessage: mockSendMessage };
        MOCK_CONFIG.telegram.isForumConfigured = true;
        MOCK_CONFIG.telegram.forumChatId = '-1003567202226';
        MOCK_CONFIG.telegram.forumTopicId = 10;
    });

    // ── Core send behaviour ──────────────────────────────────────────────────

    test('sends message to forumChatId with message_thread_id', async () => {
        await telegramService.notifySignalToForum(makeLongSignal(), makeLongDecision());

        expect(mockSendMessage).toHaveBeenCalledTimes(1);
        const [chatId, , opts] = mockSendMessage.mock.calls[0];
        expect(chatId).toBe('-1003567202226');
        expect(opts.message_thread_id).toBe(10);
        expect(opts.parse_mode).toBe('Markdown');
    });

    // ── LONG message format ──────────────────────────────────────────────────

    test('LONG signal: contains 📈, LONG, symbol, tf, entry, SL, all TPs and confidence', async () => {
        await telegramService.notifySignalToForum(makeLongSignal(), makeLongDecision());

        const [, text] = mockSendMessage.mock.calls[0];
        expect(text).toContain('📈');
        expect(text).toContain('LONG');
        expect(text).toContain('BTCUSDT');
        expect(text).toContain('1h');
        expect(text).toContain('42500');   // entry price
        expect(text).toContain('41000');   // SL
        expect(text).toContain('43500');   // TP1
        expect(text).toContain('44500');   // TP2
        expect(text).toContain('46000');   // TP3
        expect(text).toContain('50%');     // TP1 close%
        expect(text).not.toContain('78%'); // confidence NOT shown
    });

    // ── SHORT message format ─────────────────────────────────────────────────

    test('SHORT signal: contains 📉, SHORT, shortStop as SL', async () => {
        await telegramService.notifySignalToForum(makeShortSignal(), makeShortDecision());

        const [, text] = mockSendMessage.mock.calls[0];
        expect(text).toContain('📉');
        expect(text).toContain('SHORT');
        expect(text).toContain('XAUTUSDT');
        expect(text).toContain('10m');
        expect(text).toContain('2650');   // entry price
        expect(text).toContain('2700');   // SL
        expect(text).toContain('2600');   // TP1
        expect(text).not.toContain('65%'); // confidence NOT shown
    });

    // ── No-op cases ──────────────────────────────────────────────────────────

    test('silent no-op when bot is null', async () => {
        telegramService.bot = null;
        await telegramService.notifySignalToForum(makeLongSignal(), makeLongDecision());
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    test('silent no-op when isForumConfigured is false', async () => {
        MOCK_CONFIG.telegram.isForumConfigured = false;
        await telegramService.notifySignalToForum(makeLongSignal(), makeLongDecision());
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    // ── Error resilience ─────────────────────────────────────────────────────

    test('does not throw when sendMessage rejects', async () => {
        mockSendMessage.mockRejectedValue(new Error('Telegram API error'));
        await expect(
            telegramService.notifySignalToForum(makeLongSignal(), makeLongDecision())
        ).resolves.not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(
            '[Telegram] forum post failed',
            expect.objectContaining({ message: 'Telegram API error' })
        );
    });

    // ── Decision with missing sizing ─────────────────────────────────────────

    test('sends without TPs when sizing is absent', async () => {
        const decision = makeLongDecision({ risk: { sizing: null } });
        await telegramService.notifySignalToForum(makeLongSignal(), decision);
        const [, text] = mockSendMessage.mock.calls[0];
        expect(text).toContain('BTCUSDT');
        expect(text).not.toContain('TP1');
    });
});
