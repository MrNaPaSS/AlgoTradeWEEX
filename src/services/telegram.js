const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');
const { t } = require('../i18n/telegram');

class TelegramService {
    constructor() {
        this.bot = null;
        this.chatId = config.telegram.chatId;
        this.orchestrator = null;
        this._db = null;
    }

    initialize(orchestrator, database = null) {
        if (!config.telegram.botToken) {
            logger.warn('[Telegram] bot not configured — token missing');
            return;
        }

        this.orchestrator = orchestrator;
        this._db = database;
        this.bot = new TelegramBot(config.telegram.botToken, { polling: true });

        this.setupCommands();
        logger.info('[Telegram] bot started');
    }

    // ─── Helpers ────────────────────────────────────────────────────────────
    _fmtNum(v, decimals = 2) {
        const n = Number(v);
        return Number.isFinite(n) ? n.toFixed(decimals) : '—';
    }

    _dirEmoji(side) {
        const s = String(side || '').toLowerCase();
        if (s === 'long' || s === 'buy') return '📈';
        if (s === 'short' || s === 'sell') return '📉';
        return '⚪';
    }

    _md(s) {
        if (s == null) return '';
        return String(s).replace(/([_*`\[\]])/g, '\\$1');
    }

    _dirLabel(side) {
        const s = String(side || '').toLowerCase();
        if (s === 'long' || s === 'buy') return 'LONG';
        if (s === 'short' || s === 'sell') return 'SHORT';
        return 'NEUTRAL';
    }

    _getLang(chatId) {
        if (!this._db) return 'en';
        try {
            return this._db.getUserLanguage(String(chatId));
        } catch {
            return 'en';
        }
    }

    _reasonLabel(reason, lang) {
        const l = lang || 'en';
        const label = t(`reasons.${reason}`, l);
        return label === `reasons.${reason}` ? this._md(String(reason || '—')) : label;
    }

    _formatPosition(p, lang) {
        const l = lang || 'en';
        const emoji = this._dirEmoji(p.side);
        const label = this._dirLabel(p.side);
        const leverage = p.leverage ? ` x${p.leverage}` : '';
        const mode = p.mode ? ` [${p.mode}]` : '';
        let out = `${emoji} *${label}* ${p.symbol}${leverage}${mode}\n`;
        out += t('posEntry', l, { price: this._fmtNum(p.entryPrice, 4) });
        out += t('posQty', l, { qty: `${this._fmtNum(p.remainingQuantity, 6)} / ${this._fmtNum(p.totalQuantity, 6)}` });
        if (p.stopLoss) {
            const beTag = p.slMovedToBreakeven ? ' (б/у)' : '';
            out += t('posSl', l, { sl: this._fmtNum(p.stopLoss, 4), beTag });
        }
        const tps = [p.tp1Price, p.tp2Price, p.tp3Price].filter(Boolean);
        if (tps.length) {
            out += t('posTp', l, { tp: tps.map((tp, i) => `TP${i + 1} $${this._fmtNum(tp, 4)}`).join(' | ') });
        }
        out += t('posPnl', l, { pnl: this._fmtNum(p.realizedPnl, 2) });
        out += `🆔 \`${p.positionId}\`\n`;
        out += t('posStatus', l, { status: p.status });
        return out;
    }

    // ─── Command registration ──────────────────────────────────────────────
    setupCommands() {
        this.bot.onText(/^\/start/, (msg) => this._cmdStart(msg));
        this.bot.onText(/^\/help/, (msg) => this._cmdHelp(msg));
        this.bot.onText(/^\/status/, (msg) => this._cmdStatus(msg));
        this.bot.onText(/^\/balance/, (msg) => this._cmdBalance(msg));
        this.bot.onText(/^\/stats/, (msg) => this._cmdStats(msg));
        this.bot.onText(/^\/pnl(?:\s+(today|week|month))?/, (msg, match) => this._cmdPnl(msg, match?.[1] || 'today'));
        this.bot.onText(/^\/risk/, (msg) => this._cmdRisk(msg));
        this.bot.onText(/^\/agents/, (msg) => this._cmdAgents(msg));
        this.bot.onText(/^\/mode(?:\s+(fast|standard|full))?/i, (msg, match) => this._cmdMode(msg, match?.[1]));
        this.bot.onText(/^\/paper/, (msg) => this._cmdMarkMode(msg, 'paper'));
        this.bot.onText(/^\/live/, (msg) => this._cmdMarkMode(msg, 'live'));
        this.bot.onText(/^\/pause(?:\s+(.+))?/, (msg, match) => this._cmdPause(msg, match?.[1] || 'manual'));
        this.bot.onText(/^\/resume/, (msg) => this._cmdResume(msg));
        this.bot.onText(/^\/symbols/, (msg) => this._cmdSymbols(msg));
        this.bot.onText(/^\/close(?:\s+(\S+))?/, (msg, match) => this._cmdClose(msg, match?.[1]));

        this.bot.on('callback_query', (query) => this._handleCallbackQuery(query).catch((err) => {
            logger.error('[Telegram] callback_query error', { message: err.message });
        }));

        this.bot.on('message', (msg) => this._handleTextMessage(msg).catch((err) => {
            logger.error('[Telegram] message handler error', { message: err.message });
        }));
    }

    // ─── Language selection + access gate ──────────────────────────────────
    async _cmdStart(msg) {
        const userId = String(msg.from.id);
        const chatId = msg.chat.id;
        const miniAppUrl = config.multiUser?.miniAppUrl;

        const isAdmin = String(config.telegram.chatId) === userId;
        if (isAdmin) {
            const lang = this._getLang(userId);
            const replyMarkup = miniAppUrl
                ? { inline_keyboard: [[{ text: t('btnOpenApp', lang), web_app: { url: miniAppUrl } }]] }
                : undefined;
            await this.bot.sendMessage(
                chatId,
                t('adminWelcome', lang),
                { parse_mode: 'Markdown', ...(replyMarkup && { reply_markup: replyMarkup }) }
            );
            return;
        }

        const request = this._db ? await this._db.getAccessRequest(userId).catch(() => null) : null;

        // No request row yet — language hasn't been chosen
        if (!request) {
            await this.bot.sendMessage(chatId, t('chooseLanguage', 'en'), {
                reply_markup: {
                    inline_keyboard: [[
                        { text: t('btnRu', 'en'), callback_data: 'lang_ru' },
                        { text: t('btnEn', 'en'), callback_data: 'lang_en' }
                    ]]
                }
            });
            return;
        }

        await this._sendWelcomeByStatus(chatId, userId, request, request.language || 'en');
    }

    async _sendWelcomeByStatus(chatId, userId, request, lang) {
        const miniAppUrl = config.multiUser?.miniAppUrl;
        // Check if user has submitted UID yet
        if (!request || !request.weex_uid) {
            // New user: hasn't submitted UID yet
            await this.bot.sendMessage(chatId, t('newUserPrompt', lang), { parse_mode: 'Markdown' });
        } else if (request.status === 'approved') {
            // User approved: ready to use app
            const replyMarkup = miniAppUrl
                ? { inline_keyboard: [[{ text: t('btnOpenApp', lang), web_app: { url: miniAppUrl } }]] }
                : undefined;
            await this.bot.sendMessage(
                chatId,
                t('approvedWelcome', lang),
                { parse_mode: 'Markdown', ...(replyMarkup && { reply_markup: replyMarkup }) }
            );
        } else {
            // User submitted UID, waiting for admin approval
            await this.bot.sendMessage(chatId, t('pendingRequest', lang));
        }
    }

    async _handleTextMessage(msg) {
        if (!msg.text || msg.text.startsWith('/') || msg.chat.type !== 'private') return;
        if (!this._db) return;

        const userId = String(msg.from.id);
        const chatId = msg.chat.id;
        const text = msg.text.trim();

        if (String(config.telegram.chatId) === userId) return;
        const request = await this._db.getAccessRequest(userId).catch(() => null);
        // Also read language via dedicated getter (works even if request is stale)
        const savedLang = this._db.getUserLanguage(userId);
        logger.info('[Telegram] _handleTextMessage', { userId, text, request, savedLang });
        if (request?.status === 'approved') return;

        // If user hasn't chosen a language yet, prompt them first.
        // Check both sources: savedLang (via getUserLanguage) and request.language (fixed SQL).
        // savedLang defaults to 'en' when no row exists, so also verify a request row exists.
        if (!request) {
            logger.info('[Telegram] no access request row found, showing language selector');
            await this.bot.sendMessage(chatId, t('chooseLanguage', 'en'), {
                reply_markup: {
                    inline_keyboard: [[
                        { text: t('btnRu', 'en'), callback_data: 'lang_ru' },
                        { text: t('btnEn', 'en'), callback_data: 'lang_en' }
                    ]]
                }
            });
            return;
        }

        // request row exists — use language from it (now correctly fetched after SQL fix)
        const lang = request.language || savedLang || 'en';
        const weexUid = text;
        const requestId = `req_${userId}_${Date.now()}`;

        await this._db.upsertAccessRequest({
            requestId,
            userId,
            chatId: String(chatId),
            username: msg.from.username || msg.from.first_name || userId,
            weexUid
        });
        // Preserve language after upsert (upsert resets to pending but keeps language col)
        this._db.setUserLanguage(userId, lang);

        await this.bot.sendMessage(chatId, t('requestSent', lang));

        const adminChatId = config.telegram.chatId;
        if (!adminChatId) return;

        const displayName = msg.from.username
            ? `@${msg.from.username}`
            : (msg.from.first_name || userId);

        await this.bot.sendMessage(
            adminChatId,
            t('newRequestAdmin', 'ru', { name: this._md(displayName), userId, weexUid: this._md(weexUid) }),
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: t('btnApprove', 'ru'), callback_data: `approve_${userId}` },
                        { text: t('btnReject', 'ru'), callback_data: `reject_${userId}` }
                    ]]
                }
            }
        );

        logger.info('[Telegram] access request received', { userId, weexUid, displayName });
    }

    async _handleCallbackQuery(query) {
        await this.bot.answerCallbackQuery(query.id).catch(() => {});

        const data = query.data || '';

        // ── Language selection ─────────────────────────────────────────────
        if (data.startsWith('lang_')) {
            const lang = data === 'lang_ru' ? 'ru' : 'en';
            const userId = String(query.from.id);
            const chatId = query.message.chat.id;

            await this.bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

            // Save language preference for later when user submits UID
            if (this._db) {
                // Check if user already has a request (with UID)
                const existing = await this._db.getAccessRequest(userId).catch(() => null);
                if (existing && existing.weex_uid) {
                    // User already submitted UID, just changing language
                    this._db.setUserLanguage(userId, lang);
                    await this._sendWelcomeByStatus(chatId, userId, existing, lang);
                } else if (existing) {
                    // User has request but no UID yet, just save language
                    this._db.setUserLanguage(userId, lang);
                    await this.bot.sendMessage(chatId, t('newUserPrompt', lang), { parse_mode: 'Markdown' });
                } else {
                    // Brand new user: create minimal request just to store language
                    await this._db.upsertAccessRequest({
                        requestId: `req_${userId}_${Date.now()}`,
                        userId,
                        chatId: String(chatId),
                        username: query.from.username || query.from.first_name || userId,
                        weexUid: null
                    });
                    this._db.setUserLanguage(userId, lang);
                    await this.bot.sendMessage(chatId, t('newUserPrompt', lang), { parse_mode: 'Markdown' });
                }
            } else {
                // No DB: just ask for UID in chosen language
                await this.bot.sendMessage(chatId, t('newUserPrompt', lang), { parse_mode: 'Markdown' });
            }
            return;
        }

        // ── Approve / Reject ───────────────────────────────────────────────
        const underscoreIdx = data.indexOf('_');
        if (underscoreIdx === -1) return;

        const action = data.slice(0, underscoreIdx);
        const userId = data.slice(underscoreIdx + 1);

        if (action !== 'approve' && action !== 'reject') return;
        if (!this._db) return;

        const request = await this._db.getAccessRequest(userId).catch(() => null);
        if (!request) {
            logger.warn('[Telegram] callback_query: access request not found', { userId });
            return;
        }

        const status = action === 'approve' ? 'approved' : 'rejected';
        await this._db.updateAccessRequestStatus(userId, status);

        const displayName = request.username || userId;
        const uid = request.weex_uid || '—';

        const statusText = status === 'approved'
            ? t('approvedLabel', 'ru', { name: displayName, uid })
            : t('rejectedLabel', 'ru', { name: displayName });
        await this.bot.editMessageText(statusText, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        }).catch(() => {});

        const userLang = request.language || 'en';
        const miniAppUrl = config.multiUser?.miniAppUrl;

        if (status === 'approved') {
            const replyMarkup = miniAppUrl
                ? { inline_keyboard: [[{ text: t('btnOpenApp', userLang), web_app: { url: miniAppUrl } }]] }
                : undefined;
            await this.bot.sendMessage(
                request.chat_id,
                t('accessApproved', userLang),
                { parse_mode: 'Markdown', ...(replyMarkup && { reply_markup: replyMarkup }) }
            );
        } else {
            await this.bot.sendMessage(request.chat_id, t('accessRejected', userLang));
        }

        logger.info('[Telegram] access request processed', { userId, status, displayName });
    }

    // ─── Admin commands ────────────────────────────────────────────────────
    async _cmdHelp(msg) {
        const lang = this._getLang(msg.chat.id);
        this.sendMessage(t('helpText', lang), msg.chat.id);
    }

    async _cmdStatus(msg) {
        const lang = this._getLang(msg.chat.id);
        try {
            const orch = this.orchestrator;
            const positions = orch._pm.getOpen();
            const risk = orch._risk.snapshot();

            let message = t('statusHeader', lang);
            message += t('statusMode', lang, { mode: (config.trading?.mode || 'paper').toUpperCase() });
            message += t('statusArbiter', lang, { mode: orch._arbiter?.mode || '—' });
            message += risk.paused
                ? t('statusPaused', lang, { reason: risk.pauseReason || '—' })
                : t('statusActive', lang);
            message += t('statusPositions', lang, { count: positions.length });

            if (positions.length === 0) {
                message += '\n' + t('noPositions', lang);
            } else {
                message += '\n' + positions.map((p, i) => `*#${i + 1}*\n${this._formatPosition(p, lang)}`).join('\n\n');
            }
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdBalance(msg) {
        const lang = this._getLang(msg.chat.id);
        try {
            const orch = this.orchestrator;
            const isLive = (config.trading?.mode || 'paper') === 'live';
            const source = isLive ? 'WEEX (live)' : 'PaperBroker';
            const broker = orch._pm?._broker;
            let available = null;
            if (broker?.getAvailableBalanceUsd) available = await broker.getAvailableBalanceUsd();
            this.sendMessage(t('balanceMsg', lang, { source, amount: this._fmtNum(available, 2) }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdStats(msg) {
        const lang = this._getLang(msg.chat.id);
        try {
            const stats = (await this.orchestrator._db.getDailyStats?.()) || {};
            this.sendMessage(t('statsMsg', lang, {
                total:  stats.totalTrades ?? 0,
                closed: stats.closedTrades ?? 0,
                wins:   stats.winTrades ?? 0,
                losses: stats.lossTrades ?? 0,
                wr:     this._fmtNum(stats.winRate, 1),
                pnl:    this._fmtNum(stats.totalPnl, 2)
            }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdPnl(msg, period) {
        const lang = this._getLang(msg.chat.id);
        try {
            const db = this.orchestrator._db;
            const data = typeof db.getPnlForPeriod === 'function'
                ? await db.getPnlForPeriod(period)
                : await db.getDailyStats?.();
            this.sendMessage(t('pnlMsg', lang, {
                period,
                trades: data?.closedTrades ?? data?.totalTrades ?? 0,
                pnl:    this._fmtNum(data?.totalPnl ?? 0, 2)
            }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdRisk(msg) {
        const lang = this._getLang(msg.chat.id);
        try {
            const snap = this.orchestrator._risk.snapshot();
            const cfg = config.risk || {};
            this.sendMessage(t('riskMsg', lang, {
                status: snap.paused ? `⛔ PAUSED (${snap.pauseReason || '—'})` : '🟢 ACTIVE',
                pnl:    this._fmtNum(snap.dailyPnl, 2),
                loss:   this._fmtNum(cfg.maxDailyLossPercent, 1),
                maxPos: cfg.maxOpenPositions ?? '—',
                risk:   this._fmtNum(cfg.riskPerTradePercent, 1)
            }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdAgents(msg) {
        const lang = this._getLang(msg.chat.id);
        const agents = this.orchestrator._tradingAgents || [];
        const riskAgent = this.orchestrator._riskAgent;
        const lines = agents.map((a) => `• ${a.name || a.constructor.name}`);
        if (riskAgent) lines.push(`• ${riskAgent.name || riskAgent.constructor.name} (veto)`);
        lines.push(`• Arbiter (mode: ${this.orchestrator._arbiter?.mode || '—'})`);
        this.sendMessage(t('agentsMsg', lang, { list: lines.join('\n') }), msg.chat.id);
    }

    async _cmdMode(msg, mode) {
        const lang = this._getLang(msg.chat.id);
        try {
            const arbiter = this.orchestrator._arbiter;
            if (!mode) {
                this.sendMessage(t('modeCurrent', lang, { mode: arbiter?.mode || '—' }), msg.chat.id);
                return;
            }
            const upper = mode.toUpperCase();
            if (!['FAST', 'STANDARD', 'FULL'].includes(upper)) {
                this.sendMessage(t('modeInvalid', lang), msg.chat.id);
                return;
            }
            arbiter.setMode(upper);
            this.sendMessage(t('modeSwitched', lang, { mode: upper }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdMarkMode(msg, requested) {
        const lang = this._getLang(msg.chat.id);
        const current = config.trading?.mode || 'paper';
        this.sendMessage(t('modeInfo', lang, { mode: current.toUpperCase() }), msg.chat.id);
    }

    async _cmdPause(msg, reason) {
        const lang = this._getLang(msg.chat.id);
        try {
            this.orchestrator._risk.pause(reason);
            this.sendMessage(t('pauseMsg', lang, { reason }), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdResume(msg) {
        const lang = this._getLang(msg.chat.id);
        try {
            this.orchestrator._risk.resume();
            this.sendMessage(t('resumeMsg', lang), msg.chat.id);
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    async _cmdSymbols(msg) {
        const lang = this._getLang(msg.chat.id);
        const symbols = config.trading?.symbols || [];
        const tfs = config.trading?.timeframes || [];
        this.sendMessage(t('symbolsMsg', lang, {
            symbols: symbols.join(', ') || '—',
            tfs:     tfs.join(', ') || '—'
        }), msg.chat.id);
    }

    async _cmdClose(msg, arg) {
        const lang = this._getLang(msg.chat.id);
        try {
            const positions = this.orchestrator._pm.getOpen();
            if (positions.length === 0) {
                this.sendMessage(t('noPositions', lang), msg.chat.id);
                return;
            }
            let opts = {};
            if (arg) {
                if (positions.some((p) => p.positionId === arg)) opts.positionId = arg;
                else opts.symbol = arg.toUpperCase();
            }
            const result = await this.orchestrator.emergencyClose(opts);
            if (result.success) {
                const msgBody = result.closed
                    ? t('closedCount', lang, { count: result.closed })
                    : t('closedOne', lang, { id: result.position?.positionId || '—' });
                this.sendMessage(msgBody, msg.chat.id);
            } else {
                this.sendMessage(t('errClose', lang, { msg: result.error }), msg.chat.id);
            }
        } catch (err) {
            this.sendMessage(t('errGeneric', lang, { msg: err.message }), msg.chat.id);
        }
    }

    // ─── Broadcast primitives ──────────────────────────────────────────────
    async sendMessage(text, chatId = null) {
        if (!this.bot) return;
        const targetChatId = chatId || this.chatId;
        if (!targetChatId) return;
        try {
            await this.bot.sendMessage(targetChatId, text, { parse_mode: 'Markdown' });
        } catch (err) {
            logger.error('[Telegram] sendMessage failed', { message: err.message });
        }
    }

    async notifyPositionOpened(position, chatId) {
        const lang = this._getLang(chatId);
        const message = t('posOpened', lang, {
            emoji:   this._dirEmoji(position.side),
            label:   this._dirLabel(position.side),
            details: this._formatPosition(position, lang)
        });
        await this.sendMessage(message, chatId);
    }

    async notifyTakeProfitHit(data, chatId) {
        const lang = this._getLang(chatId);
        const { position, level, pnl } = data;
        const slMsg = position.slMovedToBreakeven ? t('slMovedBe', lang, { price: this._fmtNum(position.stopLoss, 4) }) : '';
        const message = t('tpHit', lang, {
            level,
            symbol: position.symbol,
            dir:    this._dirLabel(position.side),
            pnl:    this._fmtNum(pnl, 2),
            qty:    this._fmtNum(position.remainingQuantity, 6),
            slMsg
        });
        await this.sendMessage(message, chatId);
    }

    async notifyStopLossHit(data, chatId) {
        const lang = this._getLang(chatId);
        const { position, pnl } = data;
        const message = t('slHit', lang, {
            symbol: position.symbol,
            dir:    this._dirLabel(position.side),
            pnl:    this._fmtNum(pnl, 2)
        });
        await this.sendMessage(message, chatId);
    }

    async notifyPositionClosed(data, chatId) {
        const lang = this._getLang(chatId);
        const { position, reason, pnl } = data;
        const sign = Number(pnl) >= 0 ? '+' : '';
        const emoji = Number(pnl) >= 0 ? '🟢' : '🔴';
        const message = t('posClosed', lang, {
            emoji,
            symbol:   this._md(position.symbol),
            dir:      this._dirLabel(position.side),
            reason:   this._reasonLabel(reason, lang),
            pnl:      `${sign}$${this._fmtNum(pnl, 2)}`,
            realized: this._fmtNum(position.realizedPnl, 2)
        });
        await this.sendMessage(message, chatId);
    }

    async notifyError(error) {
        const text = typeof error === 'string' ? error : (error?.message || String(error));
        await this.sendMessage(t('errMsg', 'ru', { text }));
    }

    async notifyDecision(_decision) {
        // Arbiter decision details are internal — not sent to users.
    }

    // ─── Forum (public signal broadcast) ──────────────────────────────────────
    _formatSignalForForum(signal, decision) {
        const emoji = decision.direction === 'LONG' ? '📈' : '📉';
        const tps = decision.risk?.sizing?.takeProfits || [];
        const sl = decision.risk?.sizing?.stopLoss;

        let msg = `${emoji} *${decision.direction} — ${signal.symbol}* \`${signal.tf}\`\n`;
        msg += `━━━━━━━━━━━━━━━\n`;
        msg += `💰 Вход: $${this._fmtNum(signal.price, 4)}\n`;
        if (sl) msg += `🛑 SL: $${this._fmtNum(sl, 4)}\n`;
        if (tps.length) {
            msg += `\n*Take-Profit:*\n`;
            tps.forEach((tp) => {
                msg += `🎯 TP${tp.level}: $${this._fmtNum(tp.price, 4)}  _(${tp.closePercent}%)_\n`;
            });
        }
        msg += `⏰ ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`;
        return msg;
    }

    async notifySignalToForum(signal, decision) {
        if (!this.bot) return;
        if (!config.telegram.isForumConfigured) return;
        const msg = this._formatSignalForForum(signal, decision);
        try {
            await this.bot.sendMessage(config.telegram.forumChatId, msg, {
                parse_mode: 'Markdown',
                message_thread_id: config.telegram.forumTopicId
            });
            logger.info('[Telegram] signal posted to forum', {
                symbol: signal.symbol, tf: signal.tf, direction: decision.direction,
                topic: config.telegram.forumTopicId
            });
        } catch (err) {
            logger.error('[Telegram] forum post failed', { message: err.message });
        }
    }
}

module.exports = new TelegramService();
