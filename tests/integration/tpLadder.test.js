const { PositionManager } = require('../../src/services/PositionManager');
const { Database } = require('../../src/services/database');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'trades_test_tp.db');

describe('Integration: TP Ladder & Breakeven Move', () => {
    let db;
    let pm;
    let brokerMock;
    let clientMock;

    beforeEach(async () => {
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        
        db = new Database();
        // Override path for test isolation
        db._SQL = await require('sql.js')();
        db._db = new db._SQL.Database();
        // Manually run base schema
        db._db.exec(require('fs').readFileSync(path.join(__dirname, '../../src/services/database.js'), 'utf8').match(/const SCHEMA = `([\s\S]*?)`;/)[1]);
        // Also run migrations to get v4 columns
        db._migrateSchema = jest.requireActual('../../src/services/database.js').Database.prototype._migrateSchema.bind(db);
        db._migrateSchema();
        db._ensureSchemaVersion = jest.fn();
        db._markDirty = jest.fn();

        clientMock = {
            getOrder: jest.fn(),
            modifySlTp: jest.fn().mockResolvedValue({ success: true })
        };

        brokerMock = {
            mode: 'live',
            _client: clientMock,
            _takerFeeRate: 0.0004,
            placeMarketOrder: jest.fn().mockImplementation((opts) => Promise.resolve({
                orderId: 'entry-123',
                slOrderId: opts.stopLoss ? 'sl-123' : null,
                price: opts.price || 50000,
                pnl: 0
            })),
            placeTpLadder: jest.fn().mockResolvedValue({
                tp1OrderId: 'tp1-123',
                tp2OrderId: 'tp2-123',
                tp3OrderId: 'tp3-123'
            }),
            cancelAllForSymbol: jest.fn().mockResolvedValue({ cancelled: [], skipped: [] }),
            cancelOrderById: jest.fn().mockResolvedValue(null),
            // C1 fix: PositionManager now goes through the public broker surface
            // for order queries and SL modifications instead of poking _client.
            getOrder: jest.fn((args) => clientMock.getOrder(args)),
            modifySlTp: jest.fn((args) => clientMock.modifySlTp(args)),
            closeMarket: jest.fn().mockResolvedValue({ pnl: 50, price: 52000 })
        };

        pm = new PositionManager({
            database: db,
            broker: brokerMock,
            config: { risk: { tp1ClosePercent: 50, tp2ClosePercent: 30, tp3ClosePercent: 20, tpPollIntervalMs: 5000 } }
        });
    });

    afterEach(async () => {
        pm.stopTpPolling();
        await db.close();
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    });

    it('places TP ladder on open if live mode', async () => {
        const sizing = {
            quantity: 1, leverage: 5, stopLoss: 49000,
            takeProfits: [{ price: 51000 }, { price: 52000 }, { price: 53000 }]
        };

        const pos = await pm.open({ symbol: 'BTCUSDT', direction: 'LONG', markPrice: 50000, sizing });
        
        expect(brokerMock.placeMarketOrder).toHaveBeenCalled();
        expect(brokerMock.placeTpLadder).toHaveBeenCalledWith(expect.objectContaining({
            symbol: 'BTCUSDT',
            totalQty: 1,
            tp1Price: 51000,
            tp1Pct: 0.5,
            tp2Pct: 0.3,
            tp3Pct: 0.2
        }));
        
        expect(pos.tp1OrderId).toBe('tp1-123');
        expect(pos.exchangeTpActive).toBe(true);
    });

    it('moves SL to breakeven when TP1 fills via polling', async () => {
        const sizing = {
            quantity: 1, leverage: 5, stopLoss: 49000,
            takeProfits: [{ price: 51000 }, { price: 52000 }, { price: 53000 }]
        };

        await pm.open({ symbol: 'BTCUSDT', direction: 'LONG', markPrice: 50000, sizing });
        
        // Mock exchange returning FILLED for TP1 order
        clientMock.getOrder.mockImplementation(async ({ orderId }) => {
            if (orderId === 'tp1-123') return { status: 'FILLED', price: 51000, orderId };
            return { status: 'NEW' };
        });

        await pm._pollTpStatus();

        // Verify SL moved to breakeven
        expect(clientMock.modifySlTp).toHaveBeenCalledWith(expect.objectContaining({
            symbol: 'BTCUSDT',
            orderId: 'sl-123',
            slTriggerPrice: 50000 // Entry price
        }));

        const pos = pm.getOpen('BTCUSDT')[0];
        expect(pos.remainingQuantity).toBe(0.5); // 50% closed
        expect(pos.status).toBe('PARTIAL');
        expect(pos.tp1OrderId).toBeNull(); // Cleaned up
        expect(pos.slMovedToBreakeven).toBe(true);
    });

    it('cancels remaining TP orders on emergency close', async () => {
        const sizing = {
            quantity: 1, leverage: 5, stopLoss: 49000,
            takeProfits: [{ price: 51000 }]
        };

        const pos = await pm.open({ symbol: 'BTCUSDT', direction: 'LONG', markPrice: 50000, sizing });
        
        await pm.forceCloseAll('emergency');

        expect(brokerMock.cancelAllForSymbol).toHaveBeenCalledWith('BTCUSDT');
        expect(pm.getOpen('BTCUSDT').length).toBe(0);
    });
});
