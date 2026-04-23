const express = require('express');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

/**
 * User API routes for Telegram Mini App.
 * All routes require telegramAuth middleware (req.telegramUser available).
 */
function createUsersRouter({ userTradeEngine, db, telegram, registerLimiter }) {
    const router = express.Router();

    // ─── Register / connect API keys ────────────────────────────────────
    const registerMiddleware = registerLimiter
        ? [registerLimiter, express.json()]
        : [express.json()];
    router.post('/register', ...registerMiddleware, async (req, res) => {
        try {
            const tgUser = req.telegramUser;
            const { apiKey, secretKey, passphrase } = req.body || {};

            if (!apiKey || !secretKey || !passphrase) {
                return res.status(400).json({ success: false, error: 'apiKey, secretKey, passphrase обязательны' });
            }

            // Check if user already exists
            const existing = await db.getUser(tgUser.id);
            if (existing && existing.encrypted_api_key) {
                return res.status(409).json({ success: false, error: 'Вы уже зарегистрированы. Используйте PUT /api/users/me/keys для обновления.' });
            }

            // Validate keys by trying to fetch balance
            const { WeexFuturesClient } = require('../api/weex/WeexFuturesClient');
            const testClient = new WeexFuturesClient({ apiKey, secretKey, passphrase });
            let balance;
            try {
                const balRes = await testClient.getBalance();
                const data = Array.isArray(balRes) ? balRes : (balRes?.data || []);
                const usdt = data.find(b =>
                    String(b.asset || b.marginCoin || b.coin).toUpperCase() === 'USDT'
                );
                balance = parseFloat(usdt?.availableBalance || usdt?.available || '0');
                if (!Number.isFinite(balance)) {
                    return res.status(400).json({ success: false, error: 'API ключи невалидны — не удалось получить баланс' });
                }
            } catch (err) {
                logger.warn('[users] key validation failed', { message: err.message });
                return res.status(400).json({ success: false, error: `API ключи невалидны: ${err.message}` });
            }

            // Encrypt and store
            const encApiKey = encrypt(apiKey);
            const encSecret = encrypt(secretKey);
            const encPass = encrypt(passphrase);

            const userRow = {
                userId: tgUser.id,
                telegramChatId: tgUser.id,
                username: tgUser.username || tgUser.first_name,
                encryptedApiKey: encApiKey,
                encryptedSecret: encSecret,
                encryptedPassphrase: encPass,
                isActive: true,
                riskMaxDailyLossPct: 3,
                riskMaxPositions: 3,
                riskLeverage: 5,
                riskPositionSizePct: 5,
                symbols: 'BTCUSDT,ETHUSDT'
            };

            if (existing) {
                await db.updateUser(tgUser.id, {
                    encrypted_api_key: encApiKey,
                    encrypted_secret: encSecret,
                    encrypted_passphrase: encPass,
                    is_active: 1,
                    username: tgUser.username || tgUser.first_name
                });
            } else {
                await db.insertUser(userRow);
            }

            // Boot trading engine for this user
            const freshRow = await db.getUser(tgUser.id);
            await userTradeEngine.addUser(freshRow);

            // Welcome notification
            telegram.sendMessage(
                `🟢 *AlgoTrade подключён!*\n💰 Баланс: $${balance.toFixed(2)}\n\nНастройте риск-менеджмент в панели управления.`,
                tgUser.id
            ).catch(() => {});

            logger.info('[users] registered', { userId: tgUser.id, balance });
            res.json({ success: true, balance });
        } catch (err) {
            logger.error('[users] register error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Get profile ────────────────────────────────────────────────────
    router.get('/me', async (req, res) => {
        const user = await db.getUser(req.telegramUser.id);
        if (!user) {
            return res.status(404).json({ success: false, error: 'Пользователь не найден' });
        }
        res.json({
            success: true,
            user: {
                userId: user.user_id,
                username: user.username,
                isActive: Boolean(user.is_active),
                hasKeys: Boolean(user.encrypted_api_key),
                risk: {
                    maxDailyLossPct: user.risk_max_daily_loss_pct,
                    maxPositions: user.risk_max_positions,
                    leverage: user.risk_leverage,
                    positionSizePct: user.risk_position_size_pct
                },
                symbols: (user.symbols || '').split(',').filter(Boolean),
                createdAt: user.created_at
            }
        });
    });

    // ─── Update risk settings ───────────────────────────────────────────
    router.put('/me/risk', express.json(), async (req, res) => {
        try {
            const userId = req.telegramUser.id;
            const user = await db.getUser(userId);
            if (!user) return res.status(404).json({ success: false, error: 'Не найден' });

            const { maxDailyLossPct, maxPositions, leverage, positionSizePct } = req.body || {};
            const updates = {};

            if (maxDailyLossPct !== undefined) {
                const v = Number(maxDailyLossPct);
                if (v < 1 || v > 20) return res.status(400).json({ success: false, error: 'maxDailyLossPct: 1-20' });
                updates.risk_max_daily_loss_pct = v;
            }
            if (maxPositions !== undefined) {
                const v = Math.floor(Number(maxPositions));
                if (v < 1 || v > 10) return res.status(400).json({ success: false, error: 'maxPositions: 1-10' });
                updates.risk_max_positions = v;
            }
            if (leverage !== undefined) {
                const v = Math.floor(Number(leverage));
                if (v < 1 || v > 50) return res.status(400).json({ success: false, error: 'leverage: 1-50' });
                updates.risk_leverage = v;
            }
            if (positionSizePct !== undefined) {
                const v = Number(positionSizePct);
                if (v < 1 || v > 20) return res.status(400).json({ success: false, error: 'positionSizePct: 1-20' });
                updates.risk_position_size_pct = v;
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ success: false, error: 'Нет параметров для обновления' });
            }

            await db.updateUser(userId, updates);
            const freshRow = await db.getUser(userId);
            await userTradeEngine.updateUserRisk(userId, freshRow);

            res.json({ success: true, updated: updates });
        } catch (err) {
            logger.error('[users] risk update error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Update symbols ─────────────────────────────────────────────────
    router.put('/me/symbols', express.json(), async (req, res) => {
        try {
            const userId = req.telegramUser.id;
            const { symbols } = req.body || {};
            if (!Array.isArray(symbols) || symbols.length === 0) {
                return res.status(400).json({ success: false, error: 'symbols должен быть массивом' });
            }

            const allowed = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'XAUTUSDT'];
            const validated = symbols.map(s => s.toUpperCase()).filter(s => allowed.includes(s));
            if (validated.length === 0) {
                return res.status(400).json({ success: false, error: 'Нет валидных символов' });
            }

            await db.updateUser(userId, { symbols: validated.join(',') });

            // Rebuild user engine with new symbols
            const freshRow = await db.getUser(userId);
            await userTradeEngine.addUser(freshRow);

            res.json({ success: true, symbols: validated });
        } catch (err) {
            logger.error('[users] symbols update error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Status / dashboard ─────────────────────────────────────────────
    router.get('/me/status', async (req, res) => {
        try {
            const userId = req.telegramUser.id;
            const engine = userTradeEngine.getEngine(userId);
            if (!engine) {
                return res.status(404).json({ success: false, error: 'Движок не активен' });
            }

            const positions = engine.positionManager.getOpen();
            const riskSnap = engine.riskGuard.snapshot();
            // Include orphaned (pre-multi-user) trades so the Mini App shows
            // the same numbers as the bot's /stats command for the single-user case.
            const now = Date.now();
            const DAY = 24 * 60 * 60 * 1000;
            const [stats, stats7d, stats30d, allTimeStats] = await Promise.all([
                db.getDailyStats(userId, { includeOrphaned: true }),
                db._aggregateStats(userId, { includeOrphaned: true, sinceTs: now - 7 * DAY }),
                db._aggregateStats(userId, { includeOrphaned: true, sinceTs: now - 30 * DAY }),
                db.getAllTimeStats(userId, { includeOrphaned: true })
            ]);

            // Diagnostic: dump per-period aggregates so we can see on the VPS
            // exactly what SQL returned for each window.
            logger.info('[users] /me/status stats dump', {
                userId,
                now,
                sevenDaysAgo:  now - 7 * DAY,
                thirtyDaysAgo: now - 30 * DAY,
                today:    stats,
                week:     stats7d,
                month:    stats30d,
                allTime:  allTimeStats
            });

            let balance = null;
            try {
                balance = await engine.broker.getAvailableBalanceUsd();
            } catch { /* ignore */ }

            // Fetch live position data from exchange for unrealized PnL / liquidation price.
            let livePositions = [];
            try {
                if (engine.broker && typeof engine.broker.getOpenPositions === 'function') {
                    livePositions = await engine.broker.getOpenPositions();
                }
            } catch (err) {
                logger.warn('[users] live positions fetch failed', { message: err.message });
            }

            const findLive = (symbol, side) => livePositions.find(lp =>
                lp.symbol === symbol && String(lp.side).toLowerCase() === String(side).toLowerCase()
            );

            res.json({
                success: true,
                balance,
                positions: positions.map(p => {
                    const live = findLive(p.symbol, p.side);
                    return {
                        positionId: p.positionId,
                        symbol: p.symbol,
                        side: p.side,
                        entryPrice: p.entryPrice || (live && live.entryPrice) || null,
                        remainingQuantity: p.remainingQuantity,
                        leverage: p.leverage || (live && live.leverage) || null,
                        stopLoss: p.stopLoss,
                        tp1Price: p.tp1Price,
                        tp2Price: p.tp2Price,
                        tp3Price: p.tp3Price,
                        realizedPnl: p.realizedPnl,
                        unrealizedPnl: live ? live.unrealizedPnl : null,
                        liquidatePrice: live ? live.liquidatePrice : null,
                        marginSize: live ? live.marginSize : null,
                        status: p.status,
                        slMovedToBreakeven: p.slMovedToBreakeven
                    };
                }),
                risk: riskSnap,
                stats: stats || { totalTrades: 0, winTrades: 0, lossTrades: 0, totalPnl: 0, winRate: 0 },
                stats7d:  stats7d  || { totalTrades: 0, winTrades: 0, lossTrades: 0, totalPnl: 0, winRate: 0 },
                stats30d: stats30d || { totalTrades: 0, winTrades: 0, lossTrades: 0, totalPnl: 0, winRate: 0 },
                allTimeStats: allTimeStats || { totalTrades: 0, winTrades: 0, lossTrades: 0, totalPnl: 0, winRate: 0 }
            });
        } catch (err) {
            logger.error('[users] status error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Pause / Resume ─────────────────────────────────────────────────
    router.post('/me/pause', (req, res) => {
        const engine = userTradeEngine.getEngine(req.telegramUser.id);
        if (!engine) return res.status(404).json({ success: false, error: 'Не найден' });
        engine.riskGuard.pause('user_manual');
        telegram.sendMessage('⛔ Торговля приостановлена', req.telegramUser.id).catch(() => {});
        res.json({ success: true });
    });

    router.post('/me/resume', (req, res) => {
        const engine = userTradeEngine.getEngine(req.telegramUser.id);
        if (!engine) return res.status(404).json({ success: false, error: 'Не найден' });
        engine.riskGuard.resume();
        telegram.sendMessage('🟢 Торговля возобновлена', req.telegramUser.id).catch(() => {});
        res.json({ success: true });
    });

    // ─── Emergency close ────────────────────────────────────────────────
    router.post('/me/close-all', async (req, res) => {
        try {
            const engine = userTradeEngine.getEngine(req.telegramUser.id);
            if (!engine) return res.status(404).json({ success: false, error: 'Не найден' });

            const positions = engine.positionManager.getOpen();
            if (positions.length === 0) {
                return res.json({ success: true, closed: 0, message: 'Нет открытых позиций' });
            }

            await engine.positionManager.forceCloseAll('EMERGENCY_USER');
            telegram.sendMessage(
                `⚠️ *Emergency Close* — закрыто ${positions.length} позиций`,
                req.telegramUser.id
            ).catch(() => {});

            res.json({ success: true, closed: positions.length });
        } catch (err) {
            logger.error('[users] close-all error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ─── Delete account ─────────────────────────────────────────────────
    router.delete('/me', async (req, res) => {
        try {
            const userId = req.telegramUser.id;
            await userTradeEngine.removeUser(userId);
            await db.updateUser(userId, {
                encrypted_api_key: null,
                encrypted_secret: null,
                encrypted_passphrase: null,
                is_active: 0
            });
            telegram.sendMessage('🔴 Аккаунт отключён. API ключи удалены.', userId).catch(() => {});
            res.json({ success: true });
        } catch (err) {
            logger.error('[users] delete error', { message: err.message });
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

module.exports = { createUsersRouter };
