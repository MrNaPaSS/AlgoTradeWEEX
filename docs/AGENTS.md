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

## 1. Technical Agents

### BlackMirrorAgent
Executes the proprietary **Black Mirror Ultra** indicator logic.
- **Mathematical Basis**: Evaluates Trend (Fast vs Slow EMA cross over Trend EMA), RSI rebounds, and Volume Oscillator momentum.
- **Output**: Returns `LONG` or `SHORT` if the composite score exceeds the configured `threshold` (default 3/4). Confidence scales linearly with the score.

### ChandelierAgent
Calculates volatility-based trailing stop-losses using the **Chandelier Exit**.
- **Mathematical Basis**: `Highest High - (ATR * Multiplier)` for Longs, `Lowest Low + (ATR * Multiplier)` for Shorts.
- **Output**: Generates hard directional signals when the price crosses the ATR bands, signaling a trend reversal.

## 2. Risk Management: `RiskAgent`

The most critical component. It has absolute authority to issue a `VETO`.
The RiskAgent evaluates the intended direction against strict capital preservation rules.

**Responsibilities:**
1. **Drawdown Protection**: Evaluates `maxDailyLossPercent`. If the daily realized PnL drops below this threshold, the agent Vetos all trades until UTC reset.
2. **Exposure Limits**: Prevents opening new trades if `maxPositions` is reached.
3. **Dynamic Sizing**: Calculates position size using ATR to ensure risk parity.
   - `Distance to Stop Loss = ATR * slAtrMult`
   - `Quantity = (Balance * riskPercent) / (EntryPrice - StopLossPrice)`

If any risk check fails, `veto = true` is returned.

## 3. The Arbiter Layer (`Arbiter.js`)

The Arbiter is not a fixed mathematical formula; it is a Large Language Model (Claude 3.5 Sonnet or similar) accessed via OpenRouter.

### The Decision Process:
1. **Aggregation**: The Orchestrator collects all sub-agent `Votes`.
2. **Prompt Construction**: A dense JSON context is generated, containing:
   - Current Price, Symbol, Timeframe.
   - The original Webhook signal.
   - Array of all Agent Votes (including reasoning and confidence).
   - Position Sizing recommendations from the RiskAgent.
3. **LLM Evaluation**: The model is prompted with a strict system persona (Elite Quant Trader). It analyzes conflicting signals (e.g., BlackMirror says LONG, but Chandelier says NEUTRAL) and outputs a final, structured JSON verdict.
4. **Execution**: If the Arbiter outputs `LONG` or `SHORT`, the Orchestrator passes the order to the Broker. If `NEUTRAL`, the system passes on the trade.

## Error Isolation
The `BaseAgent` wrapper ensures that if any mathematical error or network timeout occurs inside a sub-agent, it safely catches the exception and returns a `NEUTRAL_VOTE` with zero confidence. This guarantees the Consilium never crashes due to a single failing agent.
