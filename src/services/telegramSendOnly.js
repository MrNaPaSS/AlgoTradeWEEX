const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Lightweight, send-only Telegram client for environments that must NOT
 * run a long-polling bot (e.g. render.com web service, where the full bot
 * runs on the remote VPS via src/app.js).
 *
 * Exposes the same surface used by the user routes and fan-out path:
 *   sendMessage(text, chatId)
 *   notifyPositionOpened(position, chatId)
 *   notifyPositionClosed(data, chatId)
 *   notifyTakeProfitHit(data, chatId)
 *   notifyStopLossHit(data, chatId)
 *   notifyError(errorOrText, chatId)
 *
 * If `TELEGRAM_BOT_TOKEN` is missing, every method becomes a no-op (returns
 * undefined) — callers already treat these as best-effort via `.catch(() => {})`.
 */
class TelegramSendOnly {
    constructor() {
        this.bot = null;
        this.chatId = config.telegram.chatId;
        const token = config.telegram.botToken;
        if (!token) {
            logger.warn('[TelegramSendOnly] TELEGRAM_BOT_TOKEN missing — all sends become no-ops');
            return;
        }
        this.bot = new TelegramBot(token, { polling: false });
        logger.info('[TelegramSendOnly] initialised (send-only, no polling)');
    }

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

    async sendMessage(text, chatId = null) {
        if (!this.bot) return;
        const target = chatId || this.chatId;
        if (!target) return;
        try {
            await this.bot.sendMessage(target, text, { parse_mode: 'Markdown' });
        } catch (err) {
            logger.error('[TelegramSendOnly] sendMessage failed', { message: err.message });
        }
    }

    async notifyPositionOpened(position, chatId) {
        const msg = `${this._dirEmoji(position.side)} *${this._dirLabel(position.side)} ОТКРЫТ*\n━━━━━━━━━━━━━━━\n${this._formatPosition(position)}`;
        await this.sendMessage(msg, chatId);
    }

    async notifyTakeProfitHit(data, chatId) {
        const { position, level, pnl } = data || {};
        if (!position) return;
        const msg = `🎯 *TP${level} ДОСТИГНУТ*\n━━━━━━━━━━━━━━━\n📊 ${position.symbol} ${this._dirLabel(position.side)}\n💵 P&L частично: $${this._fmtNum(pnl, 2)}\n📦 Остаток: ${this._fmtNum(position.remainingQuantity, 6)}${position.slMovedToBreakeven ? '\n🛡️ SL перемещён в безубыток' : ''}`;
        await this.sendMessage(msg, chatId);
    }

    async notifyStopLossHit(data, chatId) {
        const { position, pnl } = data || {};
        if (!position) return;
        const msg = `🛑 *STOP LOSS*\n━━━━━━━━━━━━━━━\n📊 ${position.symbol} ${this._dirLabel(position.side)}\n💵 P&L: $${this._fmtNum(pnl, 2)}`;
        await this.sendMessage(msg, chatId);
    }

    async notifyPositionClosed(data, chatId) {
        const { position, reason, pnl } = data || {};
        if (!position) return;
        const sign = Number(pnl) >= 0 ? '+' : '';
        const emoji = Number(pnl) >= 0 ? '🟢' : '🔴';
        const msg = `${emoji} *ПОЗИЦИЯ ЗАКРЫТА*\n━━━━━━━━━━━━━━━\n📊 ${position.symbol} ${this._dirLabel(position.side)}\n📝 Причина: ${reason}\n💵 P&L: ${sign}$${this._fmtNum(pnl, 2)}\n💰 Realized total: $${this._fmtNum(position.realizedPnl, 2)}`;
        await this.sendMessage(msg, chatId);
    }

    async notifyError(error, chatId) {
        const text = typeof error === 'string' ? error : (error?.message || String(error));
        await this.sendMessage(`⚠️ *ОШИБКА*\n━━━━━━━━━━━━━━━\n${text}`, chatId);
    }
}

module.exports = { TelegramSendOnly };
