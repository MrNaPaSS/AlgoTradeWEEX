const https = require('https');

const TOKEN = '8376094924:AAF6TlOTlRHf_3oPUFO5tUtqgAuZuNAMMcU';

https.get(`https://api.telegram.org/bot${TOKEN}/getUpdates`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.ok && json.result.length > 0) {
                // Get the last message
                const lastUpdate = json.result[json.result.length - 1];
                const chatId = lastUpdate.message?.chat?.id || lastUpdate.my_chat_member?.chat?.id;
                console.log(`FOUND_CHAT_ID=${chatId}`);
            } else {
                console.log('NO_MESSAGES_FOUND');
            }
        } catch (e) {
            console.error('Error parsing response', e);
        }
    });
}).on('error', err => {
    console.error('Request Error: ', err.message);
});
