const { createVote, NEUTRAL_VOTE } = require('../../../src/domain/Vote');

describe('Vote domain', () => {
    test('createVote returns a frozen object with defaults', () => {
        const v = createVote({ agent: 'X', direction: 'LONG', confidence: 0.7, reasoning: 'ok' });
        expect(Object.isFrozen(v)).toBe(true);
        expect(v.veto).toBe(false);
        expect(v.metrics).toEqual({});
    });

    test('createVote rejects invalid agent', () => {
        expect(() => createVote({ agent: '', direction: 'LONG', confidence: 0.5 })).toThrow();
    });

    test('createVote rejects invalid direction', () => {
        expect(() => createVote({ agent: 'A', direction: 'UP', confidence: 0.5 })).toThrow();
    });

    test('createVote rejects confidence out of [0,1]', () => {
        expect(() => createVote({ agent: 'A', direction: 'LONG', confidence: 1.5 })).toThrow();
        expect(() => createVote({ agent: 'A', direction: 'LONG', confidence: -0.1 })).toThrow();
        expect(() => createVote({ agent: 'A', direction: 'LONG', confidence: NaN })).toThrow();
    });

    test('NEUTRAL_VOTE factory', () => {
        const v = NEUTRAL_VOTE('X', 'no data');
        expect(v.direction).toBe('NEUTRAL');
        expect(v.confidence).toBe(0);
        expect(v.reasoning).toBe('no data');
    });

    test('metrics are frozen copies', () => {
        const metrics = { score: 3 };
        const v = createVote({ agent: 'A', direction: 'LONG', confidence: 0.5, metrics });
        expect(Object.isFrozen(v.metrics)).toBe(true);
        metrics.score = 99;
        expect(v.metrics.score).toBe(3);
    });
});
