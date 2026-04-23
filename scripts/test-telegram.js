require('dotenv').config();
const telegram = require('../src/services/telegram');
const config = require('../src/config/config');

async function testTelegram() {
    console.log("Testing Telegram integration...");
    try {
        telegram.initialize({
            getStatus: () => ({ hasOpenPosition: false }),
        });
        await telegram.sendMessage('✅ *AlgoTrade Pro*\nСвязь с Telegram успешно установлена! Бот готов присылать уведомления о сделках.');
        console.log("Message sent successfully!");
    } catch (e) {
        console.error("Failed to send message:", e.message);
    }
}

testTelegram();
