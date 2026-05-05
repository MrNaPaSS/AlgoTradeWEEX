const { createDecision } = require('../domain/Decision');
const logger = require('../utils/logger');

/**
 * Arbiter synthesises all agent Votes into a final Decision.
 *
 * Modes:
 *   FAST     — pure vote tally; no LLM call
 *   STANDARD — LLM only when votes are split or confidence is low
 *   FULL     — LLM on every decision; fallback to FAST if LLM unreachable
 */
class Arbiter {
    /**
     * @param {Object} opts
     * @param {import('../llm/OpenRouterClient').OpenRouterClient} [opts.llm]
     * @param {'FAST'|'STANDARD'|'FULL'} opts.mode
     * @param {number} [opts.consensusThreshold] Minimum winning-agent count (of 4 trading agents)
     * @param {import('../services/database').Database} [opts.db] Optional DB for historical memory
     */
    constructor({ llm, mode = 'STANDARD', consensusThreshold = 3, db = null } = {}) {
        this._llm = llm;
        this._mode = mode;
        this._consensusThreshold = consensusThreshold;
        this._db = db;
    }

    setMode(mode) {
        this._mode = mode;
    }

    get mode() {
        return this._mode;
    }

    /**
     * @param {Object} input
     * @param {import('../domain/types').MarketSnapshot} input.snapshot
     * @param {import('../domain/types').Vote[]} input.votes              ALL votes incl. RiskAgent
     * @param {import('../domain/types').Signal} [input.triggeringSignal]
     * @param {number} [input.overrideThreshold] Optional dynamic threshold
     * @returns {Promise<import('../domain/types').Decision>}
     */
    async decide({ snapshot, votes, triggeringSignal, overrideThreshold }) {
        const riskVote = votes.find((v) => v.agent === 'RiskAgent');
        const tradingVotes = votes.filter((v) => v.agent !== 'RiskAgent');

        const risk = this._extractRisk(riskVote);
        const tally = this._tally(tradingVotes);

        if (risk && risk.allow === false) {
            return this._buildDecision({
                snapshot,
                triggeringSignal,
                votes,
                risk,
                outcome: 'REJECT',
                direction: 'NEUTRAL',
                confidence: 0,
                reasoning: `Вето риск-модуля: ${risk.rejectReason}`,
                llmInvoked: false
            });
        }

        let outcome = 'HOLD';
        let direction = 'NEUTRAL';
        let confidence = tally.netConfidence;
        let reasoning = tally.summary;

        const threshold = Number.isInteger(overrideThreshold) ? overrideThreshold : this._consensusThreshold;

        if (tally.winnerCount >= threshold && tally.winner !== 'NEUTRAL') {
            outcome = 'EXECUTE';
            direction = tally.winner;
        }

        let llmInvoked = false;
        const needLlm =
            this._mode === 'FULL' ||
            (this._mode === 'STANDARD' && (outcome === 'HOLD' || confidence < 0.5));

        if (needLlm && this._llm?.isConfigured) {
            let historicalContext = [];
            if (this._db) {
                try {
                    const rows = await this._db.getRecentDecisions(snapshot.symbol, 5);
                    historicalContext = rows.map(r => ({
                        direction: r.direction,
                        outcome: r.outcome,
                        confidence: r.confidence,
                        realized_pnl: r.realized_pnl ?? null,
                        days_ago: Math.round((Date.now() - r.created_at) / 86400000)
                    }));
                } catch (err) {
                    logger.warn('[Arbiter] failed to load historical context', { message: err.message });
                }
            }

            const llmResult = await this._askLlm({ snapshot, votes, tally, triggeringSignal, historicalContext });
            llmInvoked = true;
            
            const llmParsed = Array.isArray(llmResult) ? llmResult[0] : llmResult;
            if (llmParsed) {
                outcome = llmParsed.outcome || outcome;
                direction = llmParsed.direction || direction;
                confidence = Number.isFinite(llmParsed.confidence) ? llmParsed.confidence : confidence;
                reasoning = llmParsed.reasoning || reasoning;
            } else {
                logger.info('[Arbiter] LLM недоступен — используем результаты голосования');
            }
        }

        // Safety-net: under normal flow, risk.allow===false is already caught
        // by the early-return on line 50. This guard exists as defense-in-depth
        // in case future refactoring removes that early return or adds LLM
        // paths that could flip outcome to EXECUTE after a risk rejection.
        if (outcome === 'EXECUTE' && (!risk || risk.allow === false)) {
            outcome = 'REJECT';
            direction = 'NEUTRAL';
            reasoning = `Риск-модуль отклонил исполнение: ${risk?.rejectReason || 'неизвестная причина'}`;
        }

        return this._buildDecision({
            snapshot,
            triggeringSignal,
            votes,
            risk,
            outcome,
            direction,
            confidence,
            reasoning,
            llmInvoked
        });
    }

    _tally(tradingVotes) {
        let longWeight = 0;
        let shortWeight = 0;
        let longCount = 0;
        let shortCount = 0;
        const breakdown = [];
        for (const v of tradingVotes) {
            breakdown.push(`${v.agent}:${v.direction}@${v.confidence.toFixed(2)}`);
            if (v.direction === 'LONG') { longWeight += v.confidence; longCount += 1; }
            else if (v.direction === 'SHORT') { shortWeight += v.confidence; shortCount += 1; }
        }
        const winner = longWeight > shortWeight ? 'LONG' : shortWeight > longWeight ? 'SHORT' : 'NEUTRAL';
        const winnerCount = winner === 'LONG' ? longCount : winner === 'SHORT' ? shortCount : 0;
        const netConfidence = Math.abs(longWeight - shortWeight) / Math.max(tradingVotes.length, 1);
        return {
            winner,
            winnerCount,
            longWeight,
            shortWeight,
            longCount,
            shortCount,
            netConfidence: Math.min(1, netConfidence),
            summary: `голоса[${breakdown.join(' ')}] итог=${netConfidence.toFixed(2)} победитель=${winner}(${winnerCount})`
        };
    }

    _extractRisk(riskVote) {
        if (!riskVote) {
            return { allow: false, rejectReason: 'RiskAgent vote missing', warnings: [] };
        }
        const sizing = riskVote.metrics?.sizing || null;
        return {
            allow: !riskVote.veto,
            rejectReason: riskVote.veto ? riskVote.reasoning : undefined,
            sizing,
            warnings: riskVote.metrics?.warnings || []
        };
    }

    async _askLlm({ snapshot, votes, tally, triggeringSignal, historicalContext = [] }) {
        const systemPrompt = [
            'You are the Chief Arbiter of an AI trading consilium operating on WEEX Futures.',
            'Synthesize the provided agent votes and market snapshot into a final decision.',
            '',
            '## Internal Debate Protocol (MANDATORY)',
            'Before producing your final JSON, mentally simulate a debate:',
            '  BULL CASE: List the strongest arguments FOR the winning direction.',
            '  BEAR CASE: List the strongest counter-arguments AGAINST it (even if you disagree).',
            '  VERDICT: Explain why the Bull or Bear case wins given the evidence.',
            '',
            'Include a concise summary of this debate inside the "reasoning" field IN RUSSIAN.',
            'Format: "🐂 [bull argument] | 🐻 [bear counter] | ✅ [verdict]"',
            '',
            'IMPORTANT: All your reasoning (the "reasoning" field) MUST BE IN RUSSIAN LANGUAGE.',
            'Respond ONLY with JSON matching this exact schema:',
            '{ "outcome": "EXECUTE"|"HOLD"|"REJECT", "direction": "LONG"|"SHORT"|"NEUTRAL", "confidence": number (0..1), "reasoning": string (IN RUSSIAN) }',
            'Guidelines:',
            '- If votes are conflicting or confidence is weak, prefer HOLD.',
            '- Do not override a Risk veto.',
            '- confidence must reflect real conviction, not vote average.',
            '- If historical_context shows recent losses in this direction, the Bear case gets extra weight.'
        ].join('\n');

        const userPrompt = JSON.stringify({
            symbol: snapshot.symbol,
            tf: snapshot.tf,
            triggeringSignal: triggeringSignal
                ? { type: triggeringSignal.signalType, price: triggeringSignal.price }
                : null,
            indicators: snapshot.indicators,
            tally: {
                winner: tally.winner,
                winnerCount: tally.winnerCount,
                longWeight: Number(tally.longWeight.toFixed(3)),
                shortWeight: Number(tally.shortWeight.toFixed(3))
            },
            historical_context: historicalContext,
            votes: votes.map((v) => ({
                agent: v.agent,
                direction: v.direction,
                confidence: v.confidence,
                veto: v.veto,
                reasoning: v.reasoning
            }))
        });

        return this._llm.askJson([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ]);
    }

    _buildDecision({ snapshot, triggeringSignal, votes, risk, outcome, direction, confidence, reasoning, llmInvoked }) {
        return createDecision({
            signalId: triggeringSignal?.id || 'internal',
            symbol: snapshot.symbol,
            outcome,
            direction,
            confidence,
            votes,
            risk: risk || { allow: false, rejectReason: 'no risk data', warnings: [] },
            arbiterReasoning: reasoning,
            arbiterMode: this._mode,
            llmInvoked
        });
    }
}

module.exports = { Arbiter };
