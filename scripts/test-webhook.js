const https = require('https');

const data = JSON.stringify({
  secret: 'super_secret_webhook_password_123',
  signalType: 'CE_BUY',
  symbol: 'BTCUSDT',
  tf: '1m',
  price: 60000
});

const options = {
  hostname: '7e1a5ee1541f825f-91-67-72-6.serveousercontent.com',
  port: 443,
  path: '/webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, res => {
  console.log(`statusCode: ${res.statusCode}`);
  let responseData = '';
  res.on('data', d => {
    responseData += d;
  });
  res.on('end', () => {
    console.log('Response:', responseData);
  });
});

req.on('error', error => {
  console.error(error);
});

req.write(data);
req.end();
