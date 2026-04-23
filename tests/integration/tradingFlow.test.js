const { TradingOrchestrator } = require('../../src/services/tradingOrchestrator');

describe('Integration: Trading Flow', () => {
    let orchestrator;
    let mockData, mockEngine, mockRisk, mockArbiter, mockPm, mockDb;

    beforeEach(() => {
        mockDb = {
            insertMarketSnapshot: jest.fn(),
            insertDecision: jest.fn(),
            insertRiskEvent: jest.fn()
        };
        mockData = {
            getCandles: jest.fn().mockReturnValue(
                Array.from({ length: 50 }, (_, i) => ({ timestamp: Date.now() - (50 - i) * 60000, close: 30000 }))
            )
        };
        mockEngine = {
            compute: jest.fn().mockReturnValue({ close: 30000, atr: 100 })
        };
        mockRisk = {
            analyze: jest.fn().mockResolvedValue({
                agent: 'RiskAgent',
                direction: 'LONG',
                veto: false,
                metrics: { sizing: { quantity: 0.1, notionalUsd: 3000, leverage: 5, stopLoss: 29500, takeProfits: [] } }
            })
        };
        mockArbiter = {
            decide: jest.fn().mockResolvedValue({
                id: 'dec-1',
                outcome: 'EXECUTE',
                direction: 'LONG',
                risk: { sizing: { quantity: 0.1, notionalUsd: 3000, leverage: 5, stopLoss: 29500, takeProfits: [] } }
            })
        };
        mockPm = {
            open: jest.fn().mockResolvedValue({ positionId: 'pos-1', symbol: 'BTCUSDT' })
        };

        orchestrator = new TradingOrchestrator({
            dataAggregator: mockData,
            indicatorEngine: mockEngine,
            tradingAgents: [{ analyze: jest.fn().mockResolvedValue({ agent: 'Mock', direction: 'LONG', veto: false }) }],
            riskAgent: mockRisk,
            arbiter: mockArbiter,
            positionManager: mockPm,
            database: mockDb,
            riskGuard: { isPaused: false }
        });
    });

    test('Full flow executes successfully', async () => {
        const signal = { id: 'sig-1', symbol: 'BTCUSDT', tf: '1h', action: 'CE_BUY' };
        
        const decision = await orchestrator.handleSignal(signal);
        
        expect(mockData.getCandles).toHaveBeenCalledWith('BTCUSDT', '1h');
        expect(mockEngine.compute).toHaveBeenCalled();
        expect(mockArbiter.decide).toHaveBeenCalled();
        expect(mockDb.insertDecision).toHaveBeenCalled();
        expect(mockPm.open).toHaveBeenCalledWith(expect.objectContaining({
            symbol: 'BTCUSDT',
            direction: 'LONG'
        }));
        expect(decision.outcome).toBe('EXECUTE');
    });

    test('Flow skips execution if trading is paused', async () => {
        orchestrator._risk.isPaused = true;
        const signal = { id: 'sig-2', symbol: 'BTCUSDT', tf: '1h' };
        
        const decision = await orchestrator.handleSignal(signal);
        
        expect(decision).toBeNull();
        expect(mockDb.insertRiskEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SIGNAL_DROPPED_PAUSED' }));
        expect(mockPm.open).not.toHaveBeenCalled();
    });

    test('Flow does not execute if Arbiter decides NEUTRAL', async () => {
        mockArbiter.decide.mockResolvedValueOnce({
            id: 'dec-3',
            outcome: 'VETO_OR_NEUTRAL',
            direction: 'NEUTRAL'
        });

        const signal = { id: 'sig-3', symbol: 'BTCUSDT', tf: '1h' };
        const decision = await orchestrator.handleSignal(signal);
        
        expect(decision.direction).toBe('NEUTRAL');
        expect(mockPm.open).not.toHaveBeenCalled();
    });
});
