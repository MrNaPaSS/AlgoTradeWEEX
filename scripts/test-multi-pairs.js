const http = require('http');

const symbols = ['SOLUSDT', 'XAUTUSDT'];

async function sendSignal(symbol) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      secret: 'super_secret_webhook_password_123',
      signalType: 'CE_BUY',
      symbol: symbol,
      tf: '1h',
      price: symbol === 'SOLUSDT' ? 100 : 2000
    });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = http.request(options, res => {
      let responseData = '';
      res.on('data', d => { responseData += d; });
      res.on('end', () => {
        console.log(`${symbol} Status: ${res.statusCode}, Response: ${responseData}`);
        resolve();
      });
    });

    req.on('error', error => { reject(error); });
    req.write(data);
    req.end();
  });
}

async function run() {
  for (const sym of symbols) {
    await sendSignal(sym);
    await new Promise(r => setTimeout(r, 15000)); // Wait for processing
  }
}

run();
