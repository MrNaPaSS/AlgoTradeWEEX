const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Telegram бот для уведомлений и управления.
 *
 * Расширенный набор команд AlgoTrade Pro v2:
 *   /status, /balance, /stats, /pnl, /risk, /agents, /mode, /paper, /live,
 *   /pause, /resume, /symbols, /close, /help
 *
 * Все команды работают с новой доменной моделью Position
 * (side: 'long'|'short', totalQuantity, remainingQuantity, realizedPnl).
 */
class TelegramService {
    constructor() {
        this.bot = null;
        this.chatId = config.telegram.chatId;
        this.orchestrator = null;
    }

    initialize(orchestrator) {
        if (!config.telegram.botToken) {
            logger.warn('[Telegram] bot not configured — token missing');
            return;
        }

        this.orchestrator = orchestrator;
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

    /**
     * Escape Telegram Markdown (legacy) reserved characters in a dynamic value
     * so things like `user_manual` don't get parsed as italic and break the
     * whole message with "Can't find end of the entity". Apply ONLY to values
     * being interpolated into a Markdown-formatted message — never to the
     * whole template (that would escape our intentional *bold* markers).
     */
    _md(s) {
        if (s == null) return '';
        return String(s).replace(/([_*`\[\]])/g, '\\$1');
    }

    /** Map internal reason codes to user-friendly labels (no underscores). */
    _reasonLabel(reason) {
        const map = {
            user_manual:        'ручное закрытие',
            admin_orphan_close: 'админ — orphan-позиции',
            EMERGENCY_USER:     'аварийное закрытие',
            EMERGENCY_MANUAL:   'аварийное закрытие',
            STOP_LOSS_HIT:      'стоп-лосс',
            TP1_HIT:            'тейк-профит 1',
            TP2_HIT:            'тейк-профит 2',
            TP3_HIT:            'тейк-профит 3',
            FORCE_CLOSE:        'принудительное закрытие',
            shutdown_liquidate: 'остановка бота'
        };
        return map[reason] || this._md(String(reason || '—'));
    }

    _dirLabel(side) {
        const s = String(side || '').toLowerCase();
        if (s === 'long' || s === 'buy') return 'LONG';
        if (s === 'short' || s === 'sell') return 'SHORT';
        return 'NEUTRAL';
    }

    _formatPosition(p) {
        const emoji = this._dirEmoji(p.side);
        const label = this._dirLabel(p.side);
        const leverage = p.leverage ? ` x${p.leverage}` : '';
        const mode = p.mode ? ` [${p.mode}]` : '';
        let out = `${emoji} *${label}* ${p.symbol}${leverage}${mode}\n`;
        out += `💰 Вход: $${this._fmtNum(p.entryPrice, 4)}\n`;
        out += `📦 Кол-во: ${this._fmtNum(p.remainingQuantity, 6)} / ${this._fmtNum(p.totalQuantity, 6)}\n`;
        if (p.stopLoss) {
            const beTag = p.slMovedToBreakeven ? ' (б/у)' : '';
            out += `🛑 SL: $${this._fmtNum(p.stopLoss, 4)}${beTag}\n`;
        }
        const tps = [p.tp1Price, p.tp2Price, p.tp3Price].filter(Boolean);
        if (tps.length) {
            out += `🎯 TP: ${tps.map((t, i) => `TP${i + 1} $${this._fmtNum(t, 4)}`).join(' | ')}\n`;
        }
        out += `💵 Realized P&L: $${this._fmtNum(p.realizedPnl, 2)}\n`;
        out += `🆔 \`${p.positionId}\`\n`;
        out += `📊 Статус: ${p.status}`;
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
    }

    async _cmdStart(msg) {
        const miniAppUrl = config.multiUser?.miniAppUrl;
        if (miniAppUrl) {
            try {
                await this.bot.sendMessage(
                    msg.chat.id,
                    '👋 *Добро пожаловать в AlgoTrade Pro!*\n\nОткройте панель управления для подключения API ключей и настройки риска.',
                    {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '🚀 Открыть панель', web_app: { url: miniAppUrl } }
                            ]]
                        }
                    }
                );
                return;
            } catch (err) {
                logger.warn('[Telegram] WebApp button failed, falling back to help', { message: err.message });
            }
        }
        await this._cmdHelp(msg);
    }

    async _cmdHelp(msg) {
        const message = `📚 *AlgoTrade Pro v2 — команды*
━━━━━━━━━━━━━━━
*Наблюдение:*
/status — открытые позиции
/balance — баланс USDT
/stats — статистика торговли
/pnl [today|week|month] — P&L за период
/risk — состояние риск-модуля
/agents — состав консилиума
/symbols — активные инструменты

*Управление:*
/mode [fast|standard|full] — режим Арбитра
/paper — текущий режим (инфо)
/live — текущий режим (инфо)
/pause [reason] — поставить торговлю на паузу
/resume — снять паузу
/close [positionId|symbol] — закрыть позицию/символ/всё`;
        this.sendMessage(message, msg.chat.id);
    }

    async _cmdStatus(msg) {
        try {
            const orch = this.orchestrator;
            const positions = orch._pm.getOpen();
            const risk = orch._risk.snapshot();

            let message = `📊 *Статус AlgoTrade Pro*\n━━━━━━━━━━━━━━━\n`;
            message += `🔌 Режим: *${(config.trading?.mode || 'paper').toUpperCase()}*\n`;
            message += `🧠 Арбитр: *${orch._arbiter?.mode || '—'}*\n`;
            message += risk.paused
                ? `⛔ Торговля на паузе: ${risk.pauseReason || '—'}\n`
                : `🟢 Торговля активна\n`;
            message += `📦 Открытых позиций: *${positions.length}*\n\n`;

            if (positions.length === 0) {
                message += `📭 Нет открытых позиций`;
            } else {
                message += positions.map((p, i) => `*#${i + 1}*\n${this._formatPosition(p)}`).join('\n\n');
            }
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdBalance(msg) {
        try {
            const orch = this.orchestrator;
            const isLive = (config.trading?.mode || 'paper') === 'live';
            let available = null;
            let source = isLive ? 'WEEX (live)' : 'PaperBroker';

            // Prefer broker wrapper if present on orchestrator
            const broker = orch._pm?._broker;
            if (broker?.getAvailableBalanceUsd) {
                available = await broker.getAvailableBalanceUsd();
            }

            const message = `💰 *Баланс*\n━━━━━━━━━━━━━━━\nИсточник: ${source}\n📗 Доступно: $${this._fmtNum(available, 2)}`;
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка баланса: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdStats(msg) {
        try {
            const stats = (await this.orchestrator._db.getDailyStats?.()) || {};
            const message = `📈 *Статистика (сегодня)*
━━━━━━━━━━━━━━━
📊 Всего сделок: ${stats.totalTrades ?? 0}
✅ Закрыто: ${stats.closedTrades ?? 0}
🟢 Прибыльных: ${stats.winTrades ?? 0}
🔴 Убыточных: ${stats.lossTrades ?? 0}
📉 Винрейт: ${this._fmtNum(stats.winRate, 1)}%
💵 P&L: $${this._fmtNum(stats.totalPnl, 2)}`;
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdPnl(msg, period) {
        try {
            const db = this.orchestrator._db;
            const data = typeof db.getPnlForPeriod === 'function'
                ? await db.getPnlForPeriod(period)
                : await db.getDailyStats?.();
            const pnl = data?.totalPnl ?? 0;
            const trades = data?.closedTrades ?? data?.totalTrades ?? 0;
            const message = `💵 *P&L — ${period}*
━━━━━━━━━━━━━━━
Сделок: ${trades}
P&L: $${this._fmtNum(pnl, 2)}`;
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdRisk(msg) {
        try {
            const snap = this.orchestrator._risk.snapshot();
            const cfg = config.risk || {};
            const message = `⚠️ *Риск-модуль*
━━━━━━━━━━━━━━━
Статус: ${snap.paused ? `⛔ PAUSED (${snap.pauseReason || '—'})` : '🟢 ACTIVE'}
Дневной P&L: $${this._fmtNum(snap.dailyPnl, 2)}
Макс. дневная потеря: ${this._fmtNum(cfg.maxDailyLossPercent, 1)}%
Макс. позиций: ${cfg.maxOpenPositions ?? '—'}
Риск на сделку: ${this._fmtNum(cfg.riskPerTradePercent, 1)}%`;
            this.sendMessage(message, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdAgents(msg) {
        const agents = this.orchestrator._tradingAgents || [];
        const riskAgent = this.orchestrator._riskAgent;
        const lines = agents.map((a) => `• ${a.name || a.constructor.name}`);
        if (riskAgent) lines.push(`• ${riskAgent.name || riskAgent.constructor.name} (veto)`);
        lines.push(`• Arbiter (mode: ${this.orchestrator._arbiter?.mode || '—'})`);
        const message = `🤖 *Консилиум агентов*\n━━━━━━━━━━━━━━━\n${lines.join('\n')}`;
        this.sendMessage(message, msg.chat.id);
    }

    async _cmdMode(msg, mode) {
        try {
            const arbiter = this.orchestrator._arbiter;
            if (!mode) {
                this.sendMessage(`🧠 Текущий режим Арбитра: *${arbiter?.mode || '—'}*\nИспользуйте: /mode fast|standard|full`, msg.chat.id);
                return;
            }
            const upper = mode.toUpperCase();
            if (!['FAST', 'STANDARD', 'FULL'].includes(upper)) {
                this.sendMessage(`❌ Неверный режим. Допустимо: fast, standard, full`, msg.chat.id);
                return;
            }
            arbiter.setMode(upper);
            this.sendMessage(`✅ Режим Арбитра переключён: *${upper}*`, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdMarkMode(msg, requested) {
        const current = config.trading?.mode || 'paper';
        if (current === requested) {
            this.sendMessage(`ℹ️ Режим уже *${requested.toUpperCase()}*.`, msg.chat.id);
        } else {
            this.sendMessage(
                `ℹ️ Текущий режим: *${current.toUpperCase()}*.\n` +
                `Переключение paper↔live производится через env \`TRADING_MODE\` и рестарт процесса.`,
                msg.chat.id
            );
        }
    }

    async _cmdPause(msg, reason) {
        try {
            this.orchestrator._risk.pause(reason);
            this.sendMessage(`⛔ Торговля приостановлена: ${reason}`, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdResume(msg) {
        try {
            this.orchestrator._risk.resume();
            this.sendMessage(`🟢 Торговля возобновлена`, msg.chat.id);
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
        }
    }

    async _cmdSymbols(msg) {
        const symbols = config.trading?.symbols || [];
        const tfs = config.trading?.timeframes || [];
        const message = `📊 *Активные инструменты*
━━━━━━━━━━━━━━━
Символы: ${symbols.join(', ') || '—'}
Таймфреймы: ${tfs.join(', ') || '—'}`;
        this.sendMessage(message, msg.chat.id);
    }

    async _cmdClose(msg, arg) {
        try {
            const positions = this.orchestrator._pm.getOpen();
            if (positions.length === 0) {
                this.sendMessage('📭 Нет открытых позиций', msg.chat.id);
                return;
            }

            let opts = {};
            if (arg) {
                // Either a positionId or a symbol
                if (positions.some((p) => p.positionId === arg)) opts.positionId = arg;
                else opts.symbol = arg.toUpperCase();
            }

            const result = await this.orchestrator.emergencyClose(opts);
            if (result.success) {
                const msgBody = result.closed
                    ? `✅ Закрыто позиций: ${result.closed}`
                    : `✅ Позиция закрыта: ${result.position?.positionId || '—'}`;
                this.sendMessage(msgBody, msg.chat.id);
            } else {
                this.sendMessage(`❌ Ошибка закрытия: ${result.error}`, msg.chat.id);
            }
        } catch (err) {
            this.sendMessage(`❌ Ошибка: ${err.message}`, msg.chat.id);
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
        const message = `${this._dirEmoji(position.side)} *${this._dirLabel(position.side)} ОТКРЫТ*
━━━━━━━━━━━━━━━
${this._formatPosition(position)}`;
        await this.sendMessage(message, chatId);
    }

    async notifyTakeProfitHit(data, chatId) {
        const { position, level, pnl } = data;
        const message = `🎯 *TP${level} ДОСТИГНУТ*
━━━━━━━━━━━━━━━
📊 ${position.symbol} ${this._dirLabel(position.side)}
💵 P&L частично: $${this._fmtNum(pnl, 2)}
📦 Остаток: ${this._fmtNum(position.remainingQuantity, 6)}
${position.slMovedToBreakeven ? '🛡️ SL перемещён в безубыток' : ''}`;
        await this.sendMessage(message, chatId);
    }

    async notifyStopLossHit(data, chatId) {
        const { position, pnl } = data;
        const message = `🛑 *STOP LOSS*
━━━━━━━━━━━━━━━
📊 ${position.symbol} ${this._dirLabel(position.side)}
💵 P&L: $${this._fmtNum(pnl, 2)}`;
        await this.sendMessage(message, chatId);
    }

    async notifyPositionClosed(data, chatId) {
        const { position, reason, pnl } = data;
        const sign = Number(pnl) >= 0 ? '+' : '';
        const emoji = Number(pnl) >= 0 ? '🟢' : '🔴';
        const message = `${emoji} *ПОЗИЦИЯ ЗАКРЫТА*
━━━━━━━━━━━━━━━
📊 ${this._md(position.symbol)} ${this._dirLabel(position.side)}
📝 Причина: ${this._reasonLabel(reason)}
💵 P&L: ${sign}$${this._fmtNum(pnl, 2)}
💰 Realized total: $${this._fmtNum(position.realizedPnl, 2)}`;
        await this.sendMessage(message, chatId);
    }

    async notifyError(error) {
        const text = typeof error === 'string' ? error : (error?.message || String(error));
        await this.sendMessage(`⚠️ *ОШИБКА*\n━━━━━━━━━━━━━━━\n${text}`);
    }

    async notifyDecision(decision) {
        const outcomeEmoji = decision.outcome === 'EXECUTE' ? '✅' : '🚫';
        const message = `${outcomeEmoji} *РЕШЕНИЕ АРБИТРА*
━━━━━━━━━━━━━━━
📊 ${decision.symbol} → *${decision.outcome}* (${decision.direction})
🎚 Уверенность: ${this._fmtNum((decision.confidence || 0) * 100, 0)}%
🤖 LLM: ${decision.llmInvoked ? 'вызван' : 'пропущено'}
🧠 ${decision.arbiterReasoning || '—'}`;
        await this.sendMessage(message);
    }
}

module.exports = new TelegramService();
