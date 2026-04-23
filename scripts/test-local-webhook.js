const http = require('http');

const data = JSON.stringify({
  secret: 'super_secret_webhook_password_123',
  signalType: 'CE_BUY',
  symbol: 'ETHUSDT',
  tf: '1h',
  price: 2500
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
  console.log(`Status: ${res.statusCode}`);
  let responseData = '';
  res.on('data', d => {
    responseData += d;
  });
  res.on('end', () => {
    console.log('Response:', responseData);
  });
});

req.on('error', error => {
  console.error('Error:', error.message);
});

req.write(data);
req.end();
