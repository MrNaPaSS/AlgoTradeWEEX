const express = require('express');
const client = require('prom-client');

// --- Registry & default metrics ---
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'algotrade_' });

// --- Custom metrics ---

/** Total orders placed (labels: symbol, side, mode) */
const ordersTotal = new client.Counter({
    name: 'algotrade_orders_total',
    help: 'Total number of orders placed',
    labelNames: ['symbol', 'side', 'mode'],
    registers: [registry]
});

/** Total agent decisions (labels: symbol, outcome, mode) */
const decisionsTotal = new client.Counter({
    name: 'algotrade_decisions_total',
    help: 'Total arbiter decisions made',
    labelNames: ['symbol', 'outcome', 'arbiter_mode'],
    registers: [registry]
});

/** Realised PnL gauge per symbol (labels: symbol, mode) */
const pnlGauge = new client.Gauge({
    name: 'algotrade_realised_pnl_usdt',
    help: 'Realised PnL in USDT',
    labelNames: ['symbol', 'mode'],
    registers: [registry]
});

/** Open positions count (labels: symbol) */
const openPositionsGauge = new client.Gauge({
    name: 'algotrade_open_positions',
    help: 'Number of currently open positions',
    labelNames: ['symbol'],
    registers: [registry]
});

/** WEEX WebSocket connection status (1 = connected, 0 = disconnected) */
const wsConnectedGauge = new client.Gauge({
    name: 'algotrade_weex_ws_connected',
    help: 'WEEX WebSocket connection status (1=connected)',
    registers: [registry]
});

/** Webhook processing duration histogram */
const webhookDurationMs = new client.Histogram({
    name: 'algotrade_webhook_duration_ms',
    help: 'Webhook processing latency in milliseconds',
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [registry]
});

/** LLM call duration histogram */
const llmDurationMs = new client.Histogram({
    name: 'algotrade_llm_duration_ms',
    help: 'OpenRouter LLM call latency in milliseconds',
    buckets: [100, 500, 1000, 2000, 5000, 10000],
    labelNames: ['model'],
    registers: [registry]
});

/** Orders that failed to place (labels: symbol, reason) */
const ordersFailedTotal = new client.Counter({
    name: 'algotrade_orders_failed_total',
    help: 'Total number of failed orders',
    labelNames: ['symbol', 'reason'],
    registers: [registry]
});

/** LLM call errors (labels: transient) */
const llmErrorsTotal = new client.Counter({
    name: 'algotrade_llm_errors_total',
    help: 'Total OpenRouter errors',
    labelNames: ['transient'],
    registers: [registry]
});

/** WebSocket reconnects */
const wsReconnectsTotal = new client.Counter({
    name: 'algotrade_weex_ws_reconnects_total',
    help: 'Total WEEX WebSocket reconnect attempts',
    registers: [registry]
});

/** RiskGuard auto-pauses (labels: reason) */
const riskPausesTotal = new client.Counter({
    name: 'algotrade_risk_pauses_total',
    help: 'Total times RiskGuard paused trading',
    labelNames: ['reason'],
    registers: [registry]
});

/** Correlation penalty applications (labels: cluster) */
const correlationPenaltiesTotal = new client.Counter({
    name: 'algotrade_correlation_penalties_total',
    help: 'Total times correlation sizing penalty was applied',
    labelNames: ['cluster'],
    registers: [registry]
});

/** Webhook duplicate signals rejected via idempotency cache */
const webhookDuplicatesTotal = new client.Counter({
    name: 'algotrade_webhook_duplicates_total',
    help: 'Webhook calls served from idempotency cache (duplicates)',
    registers: [registry]
});

/**
 * Create Prometheus /metrics route.
 * @param {{ weexWs?: import('../api/weex/WeexWebSocket').WeexWebSocket }} deps
 */
function createMetricsRouter({ weexWs } = {}) {
    const router = express.Router();

    router.get('/metrics', async (_req, res) => {
        // Update WebSocket connectivity gauge dynamically
        if (weexWs) {
            wsConnectedGauge.set(weexWs._ws?.readyState === 1 ? 1 : 0);
        }

        try {
            const output = await registry.metrics();
            res.set('Content-Type', registry.contentType);
            res.end(output);
        } catch (err) {
            res.status(500).end(err.message);
        }
    });

    return router;
}

module.exports = {
    createMetricsRouter,
    metrics: {
        ordersTotal,
        decisionsTotal,
        pnlGauge,
        openPositionsGauge,
        wsConnectedGauge,
        webhookDurationMs,
        llmDurationMs,
        ordersFailedTotal,
        llmErrorsTotal,
        wsReconnectsTotal,
        riskPausesTotal,
        correlationPenaltiesTotal,
        webhookDuplicatesTotal
    }
};
