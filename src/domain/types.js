/**
 * Domain type definitions (JSDoc). No runtime code — pure documentation
 * contracts shared across agents, indicators, brokers, and persistence.
 *
 * @typedef {'10m'|'1h'|'1D'|'1m'|'5m'|'15m'|'30m'|'4h'|'1W'} Timeframe
 * @typedef {'LONG'|'SHORT'|'NEUTRAL'} Direction
 * @typedef {'BUY'|'SELL'|'HOLD'} TradeAction
 * @typedef {'paper'|'live'} TradingMode
 * @typedef {'FAST'|'STANDARD'|'FULL'} ArbiterMode
 * @typedef {'OPEN'|'PARTIAL'|'CLOSED'|'LIQUIDATED'|'CANCELLED'} PositionStatus
 * @typedef {'EXECUTE'|'HOLD'|'REJECT'} DecisionOutcome
 *
 * @typedef {Object} Candle
 * @property {number} timestamp    Unix ms, open time
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 *
 * @typedef {Object} Signal
 * @property {string} id                     Unique signal id (nanoid)
 * @property {string} source                 'tradingview' | 'internal' | 'manual'
 * @property {string} signalType             'CE_BUY' | 'CE_SELL' | 'BM_LONG' | 'BM_SHORT'
 * @property {string} symbol
 * @property {Timeframe} tf
 * @property {number} price
 * @property {number} [longStop]
 * @property {number} [shortStop]
 * @property {number} timestamp              ms
 * @property {Record<string, unknown>} [meta]
 *
 * @typedef {Object} IndicatorSnapshot
 * @property {string} symbol
 * @property {Timeframe} tf
 * @property {number} timestamp
 * @property {number} close
 * @property {{fast: number, slow: number, trend: number}} ema
 * @property {number} rsi
 * @property {{macd: number, signal: number, histogram: number}} macd
 * @property {{upper: number, middle: number, lower: number}} bollinger
 * @property {number} atr
 * @property {number} volumeOscillator
 * @property {{longStop: number, shortStop: number, direction: 1|-1, buySignal: boolean, sellSignal: boolean}} chandelier
 * @property {{scoreLong: number, scoreShort: number, longSignal: boolean, shortSignal: boolean}} blackMirror
 * @property {{k: number, d: number}} [stochastic]
 *
 * @typedef {Object} MarketSnapshot
 * @property {string} symbol
 * @property {Timeframe} tf
 * @property {ReadonlyArray<Candle>} candles         Most-recent-last, bounded (ring buffer)
 * @property {IndicatorSnapshot} indicators
 * @property {Signal} [triggeringSignal]
 * @property {number} [fearGreedIndex]               0..100 (crypto)
 *
 * @typedef {Object} Vote
 * @property {string} agent                          Agent class name
 * @property {Direction} direction
 * @property {number} confidence                     0..1
 * @property {boolean} [veto]                        If true, RiskAgent blocks trade
 * @property {string} reasoning                      Human-readable explanation
 * @property {Record<string, unknown>} [metrics]     Agent-specific numeric context
 *
 * @typedef {Object} PositionSizing
 * @property {number} quantity                       Base asset
 * @property {number} notionalUsd
 * @property {number} leverage
 * @property {number} stopLoss
 * @property {Array<{level: 1|2|3, price: number, closePercent: number}>} takeProfits
 *
 * @typedef {Object} RiskAssessment
 * @property {boolean} allow
 * @property {string} [rejectReason]
 * @property {PositionSizing} [sizing]
 * @property {string[]} warnings
 *
 * @typedef {Object} Decision
 * @property {string} id
 * @property {string} signalId
 * @property {string} symbol
 * @property {DecisionOutcome} outcome
 * @property {Direction} direction
 * @property {number} confidence
 * @property {Vote[]} votes
 * @property {RiskAssessment} risk
 * @property {string} arbiterReasoning
 * @property {ArbiterMode} arbiterMode
 * @property {boolean} llmInvoked
 * @property {number} createdAt
 *
 * @typedef {Object} TradeOrder
 * @property {string} clientOrderId
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} quantity
 * @property {number} leverage
 * @property {number} [price]                        Undefined = market order
 * @property {number} stopLoss
 * @property {Array<{price: number, quantity: number, tpLevel: 1|2|3}>} takeProfits
 *
 * @typedef {Object} Position
 * @property {string} positionId
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} entryPrice
 * @property {number} totalQuantity
 * @property {number} remainingQuantity
 * @property {number} leverage
 * @property {number} stopLoss
 * @property {number} tp1Price
 * @property {number} tp2Price
 * @property {number} tp3Price
 * @property {PositionStatus} status
 * @property {number} realizedPnl
 * @property {number} unrealizedPnl
 * @property {boolean} slMovedToBreakeven
 * @property {TradingMode} mode
 * @property {number} openedAt
 * @property {number} [closedAt]
 * @property {string} [entryOrderId]
 * @property {string} [slOrderId]             Exchange SL order ID
 * @property {boolean} exchangeSlActive        Exchange SL is managing stop-loss
 * @property {string} [tp1OrderId]             Exchange TP1 reduce-only limit order ID
 * @property {string} [tp2OrderId]             Exchange TP2 reduce-only limit order ID
 * @property {string} [tp3OrderId]             Exchange TP3 reduce-only limit order ID
 * @property {boolean} exchangeTpActive        Exchange TP orders are placed
 * @property {string} decisionId
 */

module.exports = {};
