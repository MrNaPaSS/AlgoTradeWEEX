const translations = {
    ru: {
        chooseLanguage: '🌐 Выберите язык / Choose language',
        btnRu: '🇷🇺 Русский',
        btnEn: '🇬🇧 English',

        adminWelcome: '👋 *Добро пожаловать, администратор!*\n\nПолный доступ к AlgoTrade Pro.',
        approvedWelcome: '👋 *Добро пожаловать в AlgoTrade Pro!*\n\nОткройте приложение для подключения API ключей и настройки.',
        btnOpenApp: '🚀 Открыть приложение',
        pendingRequest: '⏳ Ваша заявка на рассмотрении. Ожидайте подтверждения от администратора.',
        newUserPrompt: '👋 *Добро пожаловать!*\n\nДля получения доступа к AlgoTrade Pro отправьте ваш *UID аккаунта WEEX*.\n\n_Найдите его в приложении WEEX → Профиль → UID_',

        requestSent: '✅ Заявка отправлена! Ожидайте подтверждения от администратора.',
        accessApproved: '🎉 *Доступ одобрен!*\n\nДобро пожаловать в AlgoTrade Pro. Откройте приложение для подключения API ключей WEEX.',
        accessRejected: '❌ В доступе отказано. Свяжитесь с поддержкой.',

        newRequestAdmin: '🔔 *Новая заявка на доступ*\n\nПользователь: {name}\nTelegram ID: `{userId}`\nWEEX UID: `{weexUid}`',
        btnApprove: '✅ Одобрить',
        btnReject: '❌ Отклонить',
        approvedLabel: '✅ Одобрено: {name} (UID: {uid})',
        rejectedLabel: '❌ Отклонено: {name}',

        helpText: '📚 *AlgoTrade Pro v2 — команды*\n━━━━━━━━━━━━━━━\n*Наблюдение:*\n/status — открытые позиции\n/balance — баланс USDT\n/stats — статистика торговли\n/pnl [today|week|month] — P\\&L за период\n/risk — состояние риск-модуля\n/agents — состав консилиума\n/symbols — активные инструменты\n\n*Управление:*\n/mode [fast|standard|full] — режим Арбитра\n/pause [reason] — поставить на паузу\n/resume — снять паузу\n/close [id|symbol] — закрыть позицию',
        statusHeader: '📊 *Статус AlgoTrade Pro*\n━━━━━━━━━━━━━━━\n',
        statusMode: '🔌 Режим: *{mode}*\n',
        statusArbiter: '🧠 Арбитр: *{mode}*\n',
        statusPaused: '⛔ Торговля на паузе: {reason}\n',
        statusActive: '🟢 Торговля активна\n',
        statusPositions: '📦 Открытых позиций: *{count}*\n',
        noPositions: '📭 Нет открытых позиций',
        balanceMsg: '💰 *Баланс*\n━━━━━━━━━━━━━━━\nИсточник: {source}\n📗 Доступно: ${amount}',
        pauseMsg: '⛔ Торговля приостановлена: {reason}',
        resumeMsg: '🟢 Торговля возобновлена',
        closedCount: '✅ Закрыто позиций: {count}',
        closedOne: '✅ Позиция закрыта: {id}',
        errClose: '❌ Ошибка закрытия: {msg}',
        errGeneric: '❌ Ошибка: {msg}',
        modeInvalid: '❌ Неверный режим. Допустимо: fast, standard, full',
        modeSwitched: '✅ Режим Арбитра переключён: *{mode}*',
        modeCurrent: '🧠 Текущий режим Арбитра: *{mode}*\nИспользуйте: /mode fast|standard|full',
        modeInfo: 'ℹ️ Текущий режим: *{mode}*.\nПереключение производится через env `TRADING_MODE` и рестарт.',
        symbolsMsg: '📊 *Активные инструменты*\n━━━━━━━━━━━━━━━\nСимволы: {symbols}\nТаймфреймы: {tfs}',
        riskMsg: '⚠️ *Риск-модуль*\n━━━━━━━━━━━━━━━\nСтатус: {status}\nДневной P\\&L: ${pnl}\nМакс. дневная потеря: {loss}%\nМакс. позиций: {maxPos}\nРиск на сделку: {risk}%',
        statsMsg: '📈 *Статистика*\n━━━━━━━━━━━━━━━\n📊 Всего сделок: {total}\n✅ Закрыто: {closed}\n🟢 Прибыльных: {wins}\n🔴 Убыточных: {losses}\n📉 Винрейт: {wr}%\n💵 P\\&L: ${pnl}',
        pnlMsg: '💵 *P\\&L — {period}*\n━━━━━━━━━━━━━━━\nСделок: {trades}\nP\\&L: ${pnl}',
        agentsMsg: '🤖 *Консилиум агентов*\n━━━━━━━━━━━━━━━\n{list}',
        errMsg: '⚠️ *ОШИБКА*\n━━━━━━━━━━━━━━━\n{text}',

        posOpened: '{emoji} *{label} ОТКРЫТ*\n━━━━━━━━━━━━━━━\n{details}',
        tpHit: '🎯 *TP{level} ДОСТИГНУТ*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n💵 P\\&L частично: ${pnl}\n📦 Остаток: {qty}\n{slMsg}',
        slHit: '🛑 *STOP LOSS*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n💵 P\\&L: ${pnl}',
        posClosed: '{emoji} *ПОЗИЦИЯ ЗАКРЫТА*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n📝 Причина: {reason}\n💵 P\\&L: {pnl}\n💰 Realized total: ${realized}',
        slMovedBe: '🔄 SL перемещён в безубыток: ${price}',
        posEntry: '💰 Вход: ${price}\n',
        posQty: '📦 Кол-во: {qty}\n',
        posSl: '🛑 SL: ${sl}{beTag}\n',
        posTp: '🎯 TP: {tp}\n',
        posPnl: '💵 Realized P\\&L: ${pnl}\n',
        posStatus: '📊 Статус: {status}',

        reasons: {
            user_manual: 'ручное закрытие',
            admin_orphan_close: 'админ — orphan-позиции',
            EMERGENCY_USER: 'аварийное закрытие',
            EMERGENCY_MANUAL: 'аварийное закрытие',
            STOP_LOSS_HIT: 'стоп-лосс',
            TP1_HIT: 'тейк-профит 1',
            TP2_HIT: 'тейк-профит 2',
            TP3_HIT: 'тейк-профит 3',
            FORCE_CLOSE: 'принудительное закрытие',
            shutdown_liquidate: 'остановка бота'
        }
    },

    en: {
        chooseLanguage: '🌐 Выберите язык / Choose language',
        btnRu: '🇷🇺 Русский',
        btnEn: '🇬🇧 English',

        adminWelcome: '👋 *Welcome, Administrator!*\n\nFull access to AlgoTrade Pro.',
        approvedWelcome: '👋 *Welcome to AlgoTrade Pro!*\n\nOpen the app to connect your API keys and configure settings.',
        btnOpenApp: '🚀 Open App',
        pendingRequest: '⏳ Your request is under review. Please wait for admin confirmation.',
        newUserPrompt: '👋 *Welcome!*\n\nTo get access to AlgoTrade Pro, send your *WEEX account UID*.\n\n_Find it in the WEEX app → Profile → UID_',

        requestSent: '✅ Request submitted! Waiting for admin confirmation.',
        accessApproved: '🎉 *Access approved!*\n\nWelcome to AlgoTrade Pro. Open the app to connect your WEEX API keys.',
        accessRejected: '❌ Access denied. Please contact support.',

        newRequestAdmin: '🔔 *New Access Request*\n\nUser: {name}\nTelegram ID: `{userId}`\nWEEX UID: `{weexUid}`',
        btnApprove: '✅ Approve',
        btnReject: '❌ Reject',
        approvedLabel: '✅ Approved: {name} (UID: {uid})',
        rejectedLabel: '❌ Rejected: {name}',

        helpText: '📚 *AlgoTrade Pro v2 — commands*\n━━━━━━━━━━━━━━━\n*Monitor:*\n/status — open positions\n/balance — USDT balance\n/stats — trading stats\n/pnl [today|week|month] — P\\&L by period\n/risk — risk module state\n/agents — agent council\n/symbols — active instruments\n\n*Control:*\n/mode [fast|standard|full] — Arbiter mode\n/pause [reason] — pause trading\n/resume — resume trading\n/close [id|symbol] — close position',
        statusHeader: '📊 *AlgoTrade Pro Status*\n━━━━━━━━━━━━━━━\n',
        statusMode: '🔌 Mode: *{mode}*\n',
        statusArbiter: '🧠 Arbiter: *{mode}*\n',
        statusPaused: '⛔ Trading paused: {reason}\n',
        statusActive: '🟢 Trading active\n',
        statusPositions: '📦 Open positions: *{count}*\n',
        noPositions: '📭 No open positions',
        balanceMsg: '💰 *Balance*\n━━━━━━━━━━━━━━━\nSource: {source}\n📗 Available: ${amount}',
        pauseMsg: '⛔ Trading paused: {reason}',
        resumeMsg: '🟢 Trading resumed',
        closedCount: '✅ Positions closed: {count}',
        closedOne: '✅ Position closed: {id}',
        errClose: '❌ Close error: {msg}',
        errGeneric: '❌ Error: {msg}',
        modeInvalid: '❌ Invalid mode. Allowed: fast, standard, full',
        modeSwitched: '✅ Arbiter mode switched: *{mode}*',
        modeCurrent: '🧠 Current Arbiter mode: *{mode}*\nUse: /mode fast|standard|full',
        modeInfo: 'ℹ️ Current mode: *{mode}*.\nSwitch via `TRADING_MODE` env \\+ restart.',
        symbolsMsg: '📊 *Active Instruments*\n━━━━━━━━━━━━━━━\nSymbols: {symbols}\nTimeframes: {tfs}',
        riskMsg: '⚠️ *Risk Module*\n━━━━━━━━━━━━━━━\nStatus: {status}\nDaily P\\&L: ${pnl}\nMax daily loss: {loss}%\nMax positions: {maxPos}\nRisk per trade: {risk}%',
        statsMsg: '📈 *Statistics*\n━━━━━━━━━━━━━━━\n📊 Total trades: {total}\n✅ Closed: {closed}\n🟢 Winning: {wins}\n🔴 Losing: {losses}\n📉 Win rate: {wr}%\n💵 P\\&L: ${pnl}',
        pnlMsg: '💵 *P\\&L — {period}*\n━━━━━━━━━━━━━━━\nTrades: {trades}\nP\\&L: ${pnl}',
        agentsMsg: '🤖 *Agent Council*\n━━━━━━━━━━━━━━━\n{list}',
        errMsg: '⚠️ *ERROR*\n━━━━━━━━━━━━━━━\n{text}',

        posOpened: '{emoji} *{label} OPENED*\n━━━━━━━━━━━━━━━\n{details}',
        tpHit: '🎯 *TP{level} HIT*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n💵 Partial P\\&L: ${pnl}\n📦 Remaining: {qty}\n{slMsg}',
        slHit: '🛑 *STOP LOSS*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n💵 P\\&L: ${pnl}',
        posClosed: '{emoji} *POSITION CLOSED*\n━━━━━━━━━━━━━━━\n📊 {symbol} {dir}\n📝 Reason: {reason}\n💵 P\\&L: {pnl}\n💰 Realized total: ${realized}',
        slMovedBe: '🔄 SL moved to breakeven: ${price}',
        posEntry: '💰 Entry: ${price}\n',
        posQty: '📦 Qty: {qty}\n',
        posSl: '🛑 SL: ${sl}{beTag}\n',
        posTp: '🎯 TP: {tp}\n',
        posPnl: '💵 Realized P\\&L: ${pnl}\n',
        posStatus: '📊 Status: {status}',

        reasons: {
            user_manual: 'manual close',
            admin_orphan_close: 'admin — orphan positions',
            EMERGENCY_USER: 'emergency close',
            EMERGENCY_MANUAL: 'emergency close',
            STOP_LOSS_HIT: 'stop loss',
            TP1_HIT: 'take profit 1',
            TP2_HIT: 'take profit 2',
            TP3_HIT: 'take profit 3',
            FORCE_CLOSE: 'force close',
            shutdown_liquidate: 'bot shutdown'
        }
    }
};

/**
 * Translate a key with optional variable interpolation.
 * @param {string} key  dot-separated key, e.g. 'reasons.STOP_LOSS_HIT'
 * @param {string} lang 'ru' | 'en'
 * @param {Object} [vars]
 */
function t(key, lang, vars) {
    const l = (lang === 'ru' || lang === 'en') ? lang : 'en';
    const dict = translations[l];
    const parts = key.split('.');
    let str = parts.reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), dict);
    if (str === null) {
        str = parts.reduce((o, k) => (o && o[k] !== undefined ? o[k] : key), translations.en);
    }
    if (!vars) return String(str);
    return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
}

module.exports = { t, translations };
