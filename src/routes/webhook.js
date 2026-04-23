const crypto = require('crypto');
const express = require('express');
const { parseSignal } = require('../domain/Signal');
const config = require('../config/config');
const logger = require('../utils/logger');

/**
 * Webhook v2 — HMAC-verified, replay-protected, idempotent signal ingest.
 *
 * Body:   { secret, signalType, symbol, tf, price, longStop?, shortStop?, timestamp? }
 * Headers (when HMAC enabled):
 *   x-timestamp:  unix-seconds, rejected if older than WEBHOOK_REPLAY_WINDOW_SECONDS
 *   x-signature:  hex(hmac-sha256(`${timestamp}.${rawBody}`, WEBHOOK_HMAC_SECRET))
 *
 * Idempotency: each signal.id is cached for WEBHOOK_IDEMPOTENCY_TTL_SECONDS;
 * duplicate deliveries within the window return the original response.
 */
function createWebhookRouter({ orchestrator, telegram, metrics } = {}) {
    const router = express.Router();

    // Per-process idempotency cache: signalId -> { decisionOutcome, expiresAt }
    const idempotencyCache = new Map();
    const idempotencyTtlMs = (config.webhook.idempotencyTtlSeconds || 300) * 1000;
    const replayWindowMs = (config.webhook.replayWindowSeconds || 300) * 1000;
    const hmacRequired = Boolean(config.webhook.hmacRequired);
    const hmacConfigured = Boolean(
        config.webhook.hmacSecret &&
        config.webhook.hmacSecret !== 'change_me_too_for_signature_validation'
    );

    if (hmacRequired && !hmacConfigured) {
        logger.warn('[webhook] HMAC required but WEBHOOK_HMAC_SECRET is default/empty — webhook will 401 every request');
    }

    // Background GC: evict expired idempotency entries even when traffic is idle.
    // .unref() so it doesn't keep the event loop alive during shutdown.
    const gcTimer = setInterval(() => purgeExpired(idempotencyCache), 60_000);
    if (typeof gcTimer.unref === 'function') gcTimer.unref();
    router.stop = () => clearInterval(gcTimer);

    router.post('/', express.json({ limit: '16kb', verify: stashRawBody }), async (req, res) => {
        const startedAt = Date.now();

        let payload = req.body;
        // TradingView sometimes wraps payload in quotes when using {{strategy.alert_message}}.
        // Unwrap up to two layers: `"\"{...}\""` -> `"{...}"` -> `{...}`.
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
                if (typeof payload === 'string') payload = JSON.parse(payload);
            } catch (e) {
                logger.warn('[webhook] failed to pre-parse string payload', { error: e.message });
            }
        }

        if (config.webhook.secret && payload?.secret !== config.webhook.secret) {
            logger.warn('[webhook] invalid secret');
            return res.status(401).json({ success: false, error: 'invalid secret' });
        }

        // --- HMAC + replay protection ---------------------------------------
        if (hmacRequired || hmacConfigured) {
            if (!hmacConfigured) {
                return res.status(500).json({ success: false, error: 'webhook hmac secret not configured' });
            }
            const tsHeader = req.headers['x-timestamp'];
            const sigHeader = req.headers['x-signature'];
            if (typeof tsHeader !== 'string' || typeof sigHeader !== 'string') {
                return res.status(401).json({ success: false, error: 'missing x-timestamp or x-signature header' });
            }
            const tsMs = Number(tsHeader) * 1000;
            if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > replayWindowMs) {
                logger.warn('[webhook] replay/stale timestamp rejected', { tsHeader });
                return res.status(401).json({ success: false, error: 'timestamp outside replay window' });
            }
            const signedPayload = `${tsHeader}.${req._rawBody || ''}`;
            if (!verifyHmac(signedPayload, sigHeader, config.webhook.hmacSecret)) {
                return res.status(401).json({ success: false, error: 'invalid hmac signature' });
            }
        }

        let signal;
        try {
            signal = parseSignal(payload);
        } catch (err) {
            logger.warn('[webhook] invalid payload', { message: err.message });
            return res.status(400).json({ success: false, error: err.message });
        }

        // --- Idempotency dedupe --------------------------------------------
        purgeExpired(idempotencyCache);
        const cached = idempotencyCache.get(signal.id);
        if (cached && cached.expiresAt > Date.now()) {
            logger.info('[webhook] duplicate signal — returning cached response', { signalId: signal.id });
            metrics?.incWebhookDuplicate?.();
            return res.json({ ...cached.response, duplicate: true });
        }

        logger.info('[webhook] signal received', {
            requestId: req.requestId, signalId: signal.id, type: signal.signalType, symbol: signal.symbol, tf: signal.tf
        });

        try {
            const decision = await orchestrator.handleSignal(signal);
            const elapsed = Date.now() - startedAt;
            if (decision && telegram) {
                telegram.notifyDecision({ ...decision, symbol: signal.symbol, tf: signal.tf })
                    .catch((e) => logger.warn('[webhook] telegram notify failed', { message: e.message }));
            }
            const response = {
                success: true,
                decisionId: decision?.id || null,
                outcome: decision?.outcome || 'DROPPED',
                direction: decision?.direction || 'NEUTRAL',
                processingTimeMs: elapsed
            };
            idempotencyCache.set(signal.id, { response, expiresAt: Date.now() + idempotencyTtlMs });
            return res.json(response);
        } catch (err) {
            logger.error('[webhook] pipeline error', { message: err.message, stack: err.stack });
            if (telegram) telegram.notifyError(`webhook pipeline error: ${err.message}`).catch(() => {});
            return res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
}

function stashRawBody(req, _res, buf) {
    req._rawBody = buf?.toString('utf8') || '';
}

function verifyHmac(payload, provided, secret) {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    try {
        const a = Buffer.from(expected);
        const b = Buffer.from(provided);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function purgeExpired(cache) {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(key);
    }
}

module.exports = { createWebhookRouter };
