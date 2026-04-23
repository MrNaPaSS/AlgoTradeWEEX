# WEEX Integration API Reference

This document details how AlgoTrade Pro interacts with the WEEX Futures infrastructure.

## Exchange Endpoints

The system is hardcoded to use the USDT-M Perpetual (Contract) APIs.
* **REST Base URL**: `https://api-contract.weex.com`
* **WebSocket URL**: `wss://ws-contract.weex.com/v3/ws/public`

## Authentication (HMAC-SHA256)

WEEX requires strict cryptographic signing for private endpoints.

**Headers Required:**
* `ACCESS-KEY`: User's API Key.
* `ACCESS-TIMESTAMP`: Unix timestamp in milliseconds.
* `ACCESS-PASSPHRASE`: API key passphrase.
* `ACCESS-SIGN`: The Base64 encoded HMAC-SHA256 signature.

**Signature Payload Formation:**
```javascript
const message = timestamp + METHOD + requestPath + queryString + body;
const signature = crypto.createHmac('sha256', secretKey).update(message).digest('base64');
```
*Note: The `queryString` must be exactly as passed in the URL, without the leading `?`.*

## Supported Features

### 1. Market Data (Public REST)
* `GET /capi/v3/market/klines`: Fetches OHLCV data. Used by the Orchestrator to build the `MarketSnapshot` before Agent analysis.
* `GET /capi/v3/market/ticker`: Fetches current Mark Price and Last Price.

### 2. Execution (Private REST)
* `POST /capi/v3/order`: Places a trade.
  AlgoTrade Pro utilizes WEEX's built-in Stop Loss / Take Profit parameters:
  * `tpTriggerPrice`: Sent automatically based on the RiskAgent's `TakeProfit 1` calculation.
  * `slTriggerPrice`: Sent automatically based on the RiskAgent's `StopLoss` calculation.
  This ensures that if AlgoTrade Pro crashes immediately after order placement, the exchange natively protects the capital.

### 3. Real-Time Telemetry (WebSocket)
The `WeexWebSocket` class maintains a persistent connection.
* **Channels**: `BTCUSDT@kline_1h`
* **Ping/Pong**: WEEX sends `{ "event": "ping" }`. The client responds with `{ "method": "PONG", "id": 1 }`.
* **Auto-Reconnect**: Exponential backoff (1s -> 30s) if the socket drops.

## Webhook Input Contract

AlgoTrade Pro expects signals from TradingView in the following JSON format to trigger the execution flow:

```json
{
  "passphrase": "HMAC_SECRET_FROM_ENV",
  "action": "CE_BUY",
  "symbol": "BTCUSDT",
  "tf": "1h",
  "price": 65000.5,
  "timestamp": "2026-04-18T12:00:00Z",
  "indicators": {
    "ce_longStop": 64000.0,
    "ce_shortStop": 66000.0,
    "bm_score": 4
  }
}
```
* `passphrase`: Used to compute HMAC signature for security (preventing unauthorized requests).
* `action`: Can be `CE_BUY`, `CE_SELL`, `BM_LONG`, `BM_SHORT`.
