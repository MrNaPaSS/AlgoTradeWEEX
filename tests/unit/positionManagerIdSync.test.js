const { PositionManager } = require('../../src/services/PositionManager');
const { createPosition, updatePosition } = require('../../src/domain/Position');
const assert = require('assert');

describe('PositionManager: ID Synchronization', () => {
    let pm, mockDb, mockBroker;

    beforeEach(() => {
        mockDb = {
            getOpenPositions: () => [],
            updatePosition: () => {},
            insertPartialClose: () => {},
            insertRiskEvent: () => {}
        };
        mockBroker = {
            mode: 'live',
            modifySlTp: async () => ({ success: true, mode: 'modify' }),
            closeMarket: async () => ({ price: 2000, pnl: 0, orderId: 'c1' })
        };
        pm = new PositionManager({ database: mockDb, broker: mockBroker });
    });

    it('should update slOrderId when modifySlTp returns a new ID in replace mode', async () => {
        const pos = createPosition({
            positionId: 'test1',
            symbol: 'ETHUSDT',
            side: 'long',
            entryPrice: 2000,
            totalQuantity: 1,
            remainingQuantity: 1,
            slOrderId: 'old_sl_id',
            status: 'OPEN'
        });
        pm._push(pos);

        // Mock broker to return a new SL ID
        mockBroker.modifySlTp = async () => ({ 
            success: true, 
            mode: 'replace', 
            slOrderId: 'new_sl_id' 
        });

        let dbUpdated = false;
        mockDb.updatePosition = (p) => {
            if (p.slOrderId === 'new_sl_id') dbUpdated = true;
        };

        // Trigger partial close (level 1) which triggers breakeven move
        // We mock markPrice to satisfy the safety distance check (2000 vs 2100)
        await pm._partialClose(pos, 2100, 1, 0.5);

        const updated = pm.getOpen('ETHUSDT')[0];
        assert.strictEqual(updated.slOrderId, 'new_sl_id', 'Memory state slOrderId should be updated');
        assert.strictEqual(dbUpdated, true, 'Database slOrderId should be updated');
    });

    it('should NOT update slOrderId if modifySlTp is in atomic modify mode', async () => {
        const pos = createPosition({
            positionId: 'test2',
            symbol: 'ETHUSDT',
            side: 'long',
            entryPrice: 2000,
            remainingQuantity: 1,
            slOrderId: 'atomic_id',
            status: 'OPEN'
        });
        pm._push(pos);

        mockBroker.modifySlTp = async () => ({ success: true, mode: 'modify' });

        await pm._partialClose(pos, 2100, 1, 0.5);

        const updated = pm.getOpen('ETHUSDT')[0];
        assert.strictEqual(updated.slOrderId, 'atomic_id', 'slOrderId should remain the same in modify mode');
    });
});
