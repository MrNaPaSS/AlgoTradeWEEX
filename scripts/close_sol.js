const http = require('http');

const data = JSON.stringify({
  secret: 'super_secret_webhook_password_123',
  signalType: 'CE_SELL',
  symbol: 'SOLUSDT',
  tf: '1h',
  price: 85
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
  res.on('data', d => { process.stdout.write(d); });
});

req.on('error', error => { console.error('Error:', error.message); });
req.write(data);
req.end();
