const { spawn } = require('child_process');

function startTunnel() {
    console.log('Starting localtunnel...');
    const lt = spawn('npx', ['localtunnel', '--port', '3000'], { shell: true });

    lt.stdout.on('data', (data) => {
        console.log(`[LT] ${data.toString().trim()}`);
    });

    lt.stderr.on('data', (data) => {
        console.error(`[LT ERR] ${data.toString().trim()}`);
    });

    lt.on('close', (code) => {
        console.log(`[LT] Process exited with code ${code}. Restarting in 2 seconds...`);
        setTimeout(startTunnel, 2000);
    });
}

startTunnel();
