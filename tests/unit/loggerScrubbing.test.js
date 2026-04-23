const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Mock config BEFORE requiring logger
jest.mock('../../src/config/config', () => ({
    weex: {
        secretKey: 'SUPER_SECRET_WEEX_KEY',
        passphrase: 'MY_PASSWORD'
    },
    openRouter: { apiKey: 'OR_KEY_123' },
    telegram: { token: 'TG_TOKEN_ABC' },
    webhook: { hmacSecret: 'HMAC_SECRET_XYZ' },
    server: { logLevel: 'info' }
}));

const logger = require('../../src/utils/logger');

describe('Unit: Logger Secret Scrubbing', () => {
    let logOutput = '';
    
    beforeAll(() => {
        // Intercept console output or check files
        // For simplicity, we can add a custom transport and check its output
        logger.add(new winston.transports.Console({
            format: winston.format.printf(({ message, ...meta }) => {
                logOutput = message + ' ' + JSON.stringify(meta);
                return logOutput;
            })
        }));
    });

    test('Redacts secrets from message string', () => {
        logger.info('Connecting with key SUPER_SECRET_WEEX_KEY and pass MY_PASSWORD');
        expect(logOutput).not.toContain('SUPER_SECRET_WEEX_KEY');
        expect(logOutput).not.toContain('MY_PASSWORD');
        expect(logOutput).toContain('[REDACTED]');
    });

    test('Redacts secrets from meta object', () => {
        logger.info('API Call', { apiKey: 'OR_KEY_123', someOtherField: 'safe' });
        expect(logOutput).not.toContain('OR_KEY_123');
        expect(logOutput).toContain('[REDACTED]');
        expect(logOutput).toContain('safe');
    });

    test('Redacts secrets from nested objects', () => {
        logger.info('Complex meta', { auth: { token: 'TG_TOKEN_ABC' } });
        expect(logOutput).not.toContain('TG_TOKEN_ABC');
        expect(logOutput).toContain('[REDACTED]');
    });

    test('Does not redact short common strings', () => {
        // "abcde" is 5 chars, threshold is > 5 in logger.js
        logger.info('Short string', { field: '12345' });
        expect(logOutput).toContain('12345');
    });
});
