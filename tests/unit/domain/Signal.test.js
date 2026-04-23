const { parseSignal, signalDirection, SIGNAL_TYPES } = require('../../../src/domain/Signal');

describe('Signal domain', () => {
    const valid = {
        source: 'tradingview',
        signalType: 'CE_BUY',
        symbol: 'btcusdt',
        tf: '1h',
        price: 50000
    };

    test('parseSignal normalises symbol to uppercase and assigns id + timestamp', () => {
        const s = parseSignal(valid);
        expect(s.symbol).toBe('BTCUSDT');
        expect(s.id).toHaveLength(12);
        expect(typeof s.timestamp).toBe('number');
        expect(Object.isFrozen(s)).toBe(true);
    });

    test('parseSignal rejects invalid signal type', () => {
        expect(() => parseSignal({ ...valid, signalType: 'FOO' })).toThrow();
    });

    test('parseSignal rejects negative price', () => {
        expect(() => parseSignal({ ...valid, price: -1 })).toThrow();
    });

    test('parseSignal coerces numeric strings to numbers', () => {
        const s = parseSignal({ ...valid, price: '42000.5' });
        expect(s.price).toBe(42000.5);
    });

    test('signalDirection maps each type correctly', () => {
        expect(signalDirection('CE_BUY')).toBe('LONG');
        expect(signalDirection('BM_LONG')).toBe('LONG');
        expect(signalDirection('CE_SELL')).toBe('SHORT');
        expect(signalDirection('BM_SHORT')).toBe('SHORT');
    });

    test('signalDirection throws on unknown type', () => {
        expect(() => signalDirection('UNKNOWN')).toThrow();
    });

    test('SIGNAL_TYPES export is complete', () => {
        expect(SIGNAL_TYPES).toEqual(expect.arrayContaining(['CE_BUY', 'CE_SELL', 'BM_LONG', 'BM_SHORT']));
    });
});
