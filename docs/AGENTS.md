# Multi-Agent AI Consilium

AlgoTrade Pro relies on a distributed Multi-Agent framework for market analysis. Rather than a monolithic strategy, the system delegates specific analytical domains to specialized sub-agents. Their individual assessments (Votes) are aggregated and judged by an LLM Arbiter.

## Core Interface: `BaseAgent`

All agents extend `BaseAgent` and implement the `_analyze(snapshot)` method.
The output is always a strongly typed `Vote` object:
```typescript
type Vote = {
    agent: string;      // Identifier (e.g., 'RiskAgent')
    direction: string;  // 'LONG', 'SHORT', or 'NEUTRAL'
    confidence: number; // 0.0 to 1.0
    veto: boolean;      // If true, forces the entire system to ABORT
    reasoning: string;  // Human/LLM-readable explanation
    metrics: object;    // Agent-specific raw data
};
```

---

## 1. Technical Agents

### BlackMirrorAgent
Executes the proprietary **Black Mirror Ultra** indicator logic.
- **Mathematical Basis**: Evaluates Trend (Fast vs Slow EMA cross over Trend EMA), RSI rebounds, and Volume Oscillator momentum.
- **Output**: Returns `LONG` or `SHORT` if the composite score exceeds the configured `threshold` (default 3/4). Confidence scales linearly with the score.

### ChandelierAgent
Calculates volatility-based trailing stop-losses using the **Chandelier Exit**.
- **Mathematical Basis**: `Highest High - (ATR * Multiplier)` for Longs, `Lowest Low + (ATR * Multiplier)` for Shorts.
- **Output**: Generates hard directional signals when the price crosses the ATR bands, signaling a trend reversal.

### TechnicalAgent
Aggregates classical technical indicators (RSI overbought/oversold, MACD crossover, Bollinger Band squeeze) into a unified directional vote.
- **Output**: `LONG` when indicators show oversold conditions, `SHORT` when overbought. Confidence correlates with the number of confirming indicators.

---

## 2. Sentiment Agents

### SentimentAgent
Evaluates market-wide sentiment using the **Fear & Greed Index** (alternative.me API).
- **Strategy**: Contrarian — extreme fear (< 25) suggests oversold market → `LONG`; extreme greed (> 75) suggests overheated market → `SHORT`.
- **Supported**: Only crypto pairs (BTC, ETH, SOL, etc.). Non-crypto symbols receive `NEUTRAL`.
- **Fallback**: If the API is unreachable, returns `NEUTRAL` with zero confidence.

### NewsAgent *(Consillium v2)*
Aggregates recent news headlines from **NewsAPI.org** and evaluates their sentiment using the system LLM.
- **Data Source**: Last 10 English-language articles matching `"{currency} crypto"`.
- **Scoring**: Headlines are forwarded to the LLM (Claude/GPT via OpenRouter) with a sentiment evaluation prompt. The LLM returns `LONG`/`SHORT`/`NEUTRAL` with calibrated confidence.
- **Caching**: Results are cached per currency for **15 minutes** to respect rate limits (Map + timestamp).
- **Supported**: BTC, ETH, SOL, BNB, XRP, ADA, XAUT. Other symbols receive `NEUTRAL`.
- **Fallback**: Returns `NEUTRAL` if `NEWS_API_KEY` is not set, LLM is unavailable, or no articles found.
- **Config**: `NEWS_API_KEY` in `.env`.

> **Note**: NewsAgent does NOT duplicate SentimentAgent. SentimentAgent reads Fear & Greed (macro-level), NewsAgent reads individual news headlines (event-level).

---

## 3. Risk Management: `RiskAgent`

The most critical component. It has absolute authority to issue a `VETO`.
The RiskAgent evaluates the intended direction against strict capital preservation rules.

**Responsibilities:**
1. **Drawdown Protection**: Evaluates `maxDailyLossPercent`. If the daily realized PnL drops below this threshold, the agent Vetos all trades until UTC reset.
2. **Exposure Limits**: Prevents opening new trades if `maxPositions` is reached.
3. **Dynamic Sizing**: Calculates position size using ATR to ensure risk parity.
   - `Distance to Stop Loss = ATR * slAtrMult`
   - `Quantity = (Balance * riskPercent) / (EntryPrice - StopLossPrice)`

If any risk check fails, `veto = true` is returned.

---

## 4. The Arbiter Layer (`Arbiter.js`)

The Arbiter is not a fixed mathematical formula; it is a Large Language Model (Claude 3.5 Sonnet or similar) accessed via OpenRouter.

### Modes of Operation

| Mode | LLM Called When | Use Case |
|---|---|---|
| `FAST` | Never | Maximum speed, pure vote tally |
| `STANDARD` | Votes split or confidence < 0.5 | **Recommended** — best speed/quality tradeoff |
| `FULL` | Every decision | Maximum quality, higher latency and cost |

### The Decision Process:
1. **Aggregation**: The Orchestrator collects all sub-agent `Votes`.
2. **Adaptive Threshold** *(v2)*: Based on current ATR%, the consensus threshold is dynamically adjusted (see below).
3. **Vote Tally**: Count directional votes. If `winnerCount >= threshold` → `EXECUTE`.
4. **LLM Evaluation** (when triggered by mode): A dense JSON context is generated, containing:
   - Current Price, Symbol, Timeframe, triggering signal.
   - Array of all Agent Votes (including reasoning and confidence).
   - **Historical Context** *(v2)*: Last 5 executed decisions on this symbol with realized PnL.
5. **Internal Debate Protocol** *(v2)*: The LLM is instructed to conduct a Bull vs Bear debate before making a decision (see below).
6. **Execution**: If the Arbiter outputs `EXECUTE` + `LONG`/`SHORT`, the Orchestrator passes the order to the Broker. If `HOLD` or `NEUTRAL`, the system passes on the trade.

### Decision Memory *(Consillium v2)*

Before each LLM call, the Arbiter queries the database for the last 5 `EXECUTE` decisions on the current symbol (via `db.getRecentDecisions()`). Each record includes:
- Direction (LONG/SHORT)
- Realized PnL (profit or loss)
- Days ago

This context is injected into the LLM prompt as `historical_context`. If the system observes a pattern of consecutive losses in a given direction, the LLM is instructed to raise the bar for conviction before approving another trade in the same direction.

**Fallback**: If the database is unavailable, the Arbiter continues without historical context (non-fatal).

### Internal Debate Protocol *(Consillium v2)*

The `systemPrompt` mandates a structured internal dialogue:

```
BULL CASE: List the strongest arguments FOR the winning direction.
BEAR CASE: List the strongest counter-arguments AGAINST it.
VERDICT:   Explain why the Bull or Bear case wins.
```

The debate summary is included in the `reasoning` field in Russian, formatted as:
`🐂 [bull argument] | 🐻 [bear counter] | ✅ [verdict]`

This technique (self-debate prompting) improves LLM reasoning quality without requiring additional API calls.

### Adaptive Consensus Threshold *(Consillium v2)*

The `consensusThreshold` is dynamically computed by the Orchestrator based on current market volatility (ATR as a percentage of price):

| ATR % of Price | Threshold | Market Regime |
|---|---|---|
| < 0.5% | 2 | Very calm — trade more freely |
| 0.5% – 1.5% | 3 | Normal — balanced (default) |
| 1.5% – 3.0% | 4 | Volatile — require near-unanimity |
| ≥ 3.0% | 5 | Extreme — unanimity required |

This is computed in `TradingOrchestrator._computeAdaptiveThreshold()` and passed to `arbiter.decide()` as `overrideThreshold`.

---

## Error Isolation
The `BaseAgent` wrapper ensures that if any mathematical error or network timeout occurs inside a sub-agent, it safely catches the exception and returns a `NEUTRAL_VOTE` with zero confidence. This guarantees the Consilium never crashes due to a single failing agent.
