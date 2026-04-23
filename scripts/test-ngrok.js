const https = require('https');

https.get('https://cytoclastic-audria-overlightly.ngrok-free.dev/', (res) => {
    console.log(`Status: ${res.statusCode}`);
    res.on('data', d => process.stdout.write(d));
}).on('error', e => console.error(e));
