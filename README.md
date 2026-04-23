# AlgoTrade Pro v2

**Enterprise AI-Powered Futures Trading System for WEEX** — multi-agent consilium with LLM arbiter (OpenRouter/Claude), Black Mirror Ultra indicator, deterministic paper/live trading modes.

> ⚠️  Торгует **только фьючерсами** (XAUTUSDT, BTCUSDT, ETHUSDT) на WEEX. Paper-режим по умолчанию.

---

## Ключевые возможности

| Функция | Описание |
|---|---|
| 🧠 **Консилиум из 5 агентов** | TechnicalAgent, BlackMirrorAgent, ChandelierAgent, SentimentAgent, RiskAgent |
| 🤖 **LLM-арбитр** | OpenRouter → Claude/GPT выносит финальное решение (режимы FAST / STANDARD / FULL) |
| 📈 **Black Mirror Ultra** | Портированный из Pine Script индикатор (score 0-4 + Chandelier Exit) |
| 🛡 **Risk Guard** | Daily-loss kill-switch, veto по дубликатам, per-symbol лимиты позиций |
| 🔄 **Multi-symbol** | `Map<symbol, Position[]>` + per-symbol async-mutex, никаких гонок |
| 📊 **Full observability** | Prometheus `/metrics`, `/health`, `/ready`, request-id tracing |
| 💵 **Paper ↔ Live** | Одинаковый интерфейс брокера, переключение через env |
| 📱 **Telegram v2** | 13 команд управления (`/status`, `/mode`, `/close`, `/pause` и т.д.) |
| 🧪 **80%+ test coverage** | Jest: 94+ unit + integration тестов |

---

## Быстрый старт

```bash
# 1. Клон и установка
git clone <repo>
cd AlgoTrade
npm install

# 2. Конфиг
cp .env.example .env
# ▸ Заполни WEEX_*, OPENROUTER_API_KEY, TELEGRAM_*

# 3. Тесты
npm test

# 4. Запуск (PAPER by default)
npm start
```

REST:
- `POST /webhook` — приём сигналов TradingView
- `GET /health` / `GET /ready` — liveness/readiness probes
- `GET /metrics` — Prometheus-счётчики

---

## Архитектура

```
Signal (TradingView webhook)
      ↓
DataAggregator  →  IndicatorEngine  (pure)
      ↓
┌──────── Consilium (parallel) ────────┐
│ Technical │ BlackMirror │ Chandelier │
│ Sentiment │                          │
└────────┬─────────────────────────────┘
         ↓
    RiskAgent (veto + sizing)
         ↓
    Arbiter (LLM / consensus)
         ↓
    PositionManager → Broker (Paper | Live WEEX)
         ↓
    SQLite + Telegram + Prometheus
```

Подробнее: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/AGENTS.md`](docs/AGENTS.md), [`docs/API.md`](docs/API.md).

---

## Режимы торговли

| Режим | env | Поведение |
|---|---|---|
| **Paper** (дефолт) | `TRADING_MODE=paper` | `PaperBroker` с симуляцией slippage + fee, стартовый баланс `PAPER_STARTING_BALANCE` |
| **Live** | `TRADING_MODE=live` | Реальные ордера через WEEX `/api/mix/v1/*` |

Переключение требует рестарта процесса — это намеренно: защита от случайного live-тумблера.

---

## Режимы Арбитра

| Режим | Когда LLM вызывается | Latency |
|---|---|---|
| `FAST` | Никогда (чистый consensus) | <50ms |
| `STANDARD` | При HOLD или confidence < 0.5 | ~1-3s |
| `FULL` | На каждый сигнал | ~2-5s |

Переключение: `/mode fast|standard|full` в Telegram.

---

## Скрипты

```bash
npm test                # Все тесты
npm run test:coverage   # С coverage-отчётом
npm run test:integration
npm run backtest -- --symbol BTCUSDT --tf 1h
npm run verify:indicators
```

---

## Deployment

```bash
# Production (Node 18+)
NODE_ENV=production TRADING_MODE=paper npm start

# PM2
pm2 start src/app.js --name algotrade-pro -i 1
```

Для приёма webhook`ов снаружи — [ngrok](https://ngrok.com) или [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

---

## Структура проекта

```
src/
├── app.js              # Bootstrap (DI container, WS, Express)
├── config/             # Zod-валидированный env-конфиг
├── domain/             # Position, Signal, Vote, Decision (immutable)
├── indicators/         # EMA/RSI/MACD/BB/ATR/CE/BlackMirror/VolOsc/Stoch (pure)
├── agents/             # 5 агентов + Arbiter
├── services/           # Orchestrator, PositionManager, RiskGuard, Paper/Live broker, DB
├── api/weex/           # REST client + WebSocket (auto-reconnect)
├── llm/                # OpenRouter client (timeout + cache)
├── routes/             # /webhook /health /metrics
├── middleware/         # requestId, rateLimit, errorHandler
└── utils/              # logger, retry, circuitBreaker
tests/
├── unit/               # indicators, agents, domain
├── integration/        # webhook → pipeline → broker
└── fixtures/
scripts/
├── backtest.js         # Оффлайн-прогон стратегии
└── verify-indicators.js# Сверка с TradingView
docs/                   # ARCHITECTURE / AGENTS / API
```

---

## Telegram команды

```
/status                     — открытые позиции + режим
/balance                    — USDT доступно
/stats | /pnl [today|week|month]
/risk                       — снимок RiskGuard
/agents                     — состав консилиума
/mode [fast|standard|full]  — переключение режима Арбитра
/paper | /live              — информация о режиме
/pause [reason] | /resume
/symbols                    — активные инструменты
/close [positionId|symbol]  — emergency close
/help
```

---

## Лицензия

MIT © [@kaktotakxm](https://github.com/kaktotakxm)
