# BTC 15m Kalshi / Polymarket Arbitrage Simulator

A paper-trading simulator for cross-venue arbitrage on 15-minute BTC "Up or Down" markets. It watches Kalshi and Polymarket, opens simulated positions when a combo of opposite-side contracts is cheap enough, settles them against the real outcomes, and shows everything in a live dashboard.

**No real money is used and no orders are sent.** Every trade is simulated.

## Strategy

For each 15-minute window, both venues list a "BTC goes up" (UP) and "BTC goes down" (DOWN) contract. Each contract pays 100¢ if it wins and 0¢ if it loses. The simulator looks at two combos:

- `K_UP+P_DOWN`: buy UP on Kalshi and DOWN on Polymarket
- `K_DOWN+P_UP`: buy DOWN on Kalshi and UP on Polymarket

Exactly one of the two legs in a combo pays out when both venues resolve the same way, so the combo costs `kalshiAsk + polyAsk` and returns 100¢. If that total is below `MAX_TOTAL_COST` (default 90¢), the difference is the locked profit per contract.

A trade is opened only when:

- the combo is tradable (total cost < `MAX_TOTAL_COST`),
- the event still has more than `NO_TRADE_LAST_SEC` seconds left,
- the per-event trade limit and the cooldown allow it.

### The strike-mismatch risk

Each venue defines its own "price to beat" (strike) for the same window. They are often equal but can differ. If BTC closes between the two strikes, the venues resolve in opposite directions. Then **both legs of the combo lose**: you pay the total cost and receive nothing. The dashboard flags this on every trade where the strikes differ. The lock only holds when the strikes match or the close lands outside the gap.

The simulator reports this honestly. A losing trade is explained in the trade detail, not hidden.

## Setup

```bash
git clone <this-repo-url> kalshi-polymarket-arbitrage
cd kalshi-polymarket-arbitrage
bun install
cp .env.example .env
bun run start
```

Then open http://localhost:3000.

No API keys are required. The dashboard runs on public data alone. The optional authenticated websocket settings in `.env.example` add faster and more accurate feeds (see [Live data & update rates](#live-data--update-rates)).

Keep `.env` and any `*.pem` key file out of git. Both are listed in `.gitignore`. Secrets are never logged.

## Reading the dashboard

- **Header**: connection dot (green live, amber connecting or stale, red disconnected), BTC price, the current event window with a countdown to close, and trades opened in this event versus the limit.
- **Kalshi / Polymarket panels**: market id, strike (price to beat), Up and Down ask and bid in cents, and time left.
- **Arbitrage combos**: each combo's two asks, total cost, and locked profit. A green **TRADABLE** badge means the total cost is below the max.
- **Charts**: live total cost of both combos against the dashed max line, and cumulative PnL (green above zero, red below).
- **Stats**: total PnL, win rate, wins and losses, open and settled trades, and total staked.
- **Trades**: click a row, or "Why?", to expand it. The detail shows:
  - the entry reason, both strikes and BTC at entry, so you can see why the trade was taken;
  - the real result on each venue and whether each leg won;
  - payout, PnL and the outcome explanation.

  Filter by event (dropdown, which also groups rows with per-event PnL) and by status (open, settled, won, lost).

Prices are in cents (66¢ = $0.66 per contract). Money uses signed notation such as +$2.30 and -$1.00.

## Live data & update rates

- **Polymarket spot** is Chainlink BTC/USD, streamed through the Polymarket RTDS websocket. Polymarket resolves on this feed.
- **Kalshi** resolves on the CF Benchmarks BRTI index. BRTI has no free live feed, so the dashboard shows a median of constituent-exchange mids as an approximation (expect about ±$3 versus the index). The 60s average on each panel is the settlement estimate.
- **Up/Down prices** for Polymarket are pushed over the CLOB websocket. For Kalshi they come from REST polling every `KALSHI_BOOK_POLL_MS` (350 ms by default), unless a Kalshi API key websocket is configured.
- Each panel shows where its quotes came from (`WS push` or `REST`) and how old they are. A spot price older than 5 s is grayed out and marked stale.
- The Feeds strip shows, per feed: connection status, messages/s, price updates/s, latency and last-message age. Below the feeds, a summary line gives the Kalshi and Polymarket Up/Down updates/s, with `(ws)` or `(rest)` for how Kalshi quotes arrive. Tick and broadcast rates are at the right.

### With and without keys

| | Without API keys | With API keys |
| --- | --- | --- |
| Kalshi Up/Down prices | REST poll every `KALSHI_BOOK_POLL_MS` (350 ms default), shown as `REST` | Kalshi websocket push, shown as `WS push` (`kalshiBookWs` feed) |
| Kalshi spot (settles on BRTI) | Approximation: median of exchange mids, about ±$3 versus the index | CF Benchmarks BRTI live index, 5 Hz, via the Kalshi websocket |
| Polymarket Up/Down prices | CLOB websocket push | CLOB websocket push (same) |
| Polymarket spot (resolves on Chainlink) | Chainlink BTC/USD spot, not TWAP | Chainlink 60s TWAP via Polymarket's live-data websocket (the actual resolution source) |

Without keys the dashboard works on public data. The authenticated websockets are optional but strongly recommended, because they remove most of the polling delay on Kalshi and match the exact settlement sources.

### Spot sources

- **Kalshi** resolves on the CF Benchmarks BRTI index. With `KALSHI_API_KEY_ID` and a private key, BRTI is streamed through the Kalshi websocket at 5 Hz (`CF Benchmarks BRTI (live index, 5Hz)`). Without keys, the dashboard shows a median of constituent-exchange mids (`≈ BRTI proxy`, expect about ±$3 versus the index).
- **Polymarket** resolves on the Chainlink BTC/USD 60s TWAP. With `POLY_API_KEY`, `POLY_API_SECRET` and `POLY_API_PASSPHRASE`, the TWAP is streamed via Polymarket's live-data websocket (`Chainlink 60s TWAP`). Without them, the dashboard shows plain Chainlink BTC/USD spot (`not TWAP`).
- The 60s average on each panel is the settlement estimate for both venues.

### Enabling the authenticated websockets

1. Create a Kalshi API key and download its private key PEM. Save it as `kalshi_private_key.pem` in the repo root, or use `KALSHI_PRIVATE_KEY` inline.
2. Create Polymarket CLOB API credentials (key, secret, passphrase).
3. Fill in the commented-out variables in `.env` (see `.env.example`), then restart with `bun run start`.
4. Open the dashboard and check the Feeds strip. The Kalshi summary should read `Kalshi Up/Down updates/s: … (ws)`, and the `kalshiBookWs` row should show `connected` with a latency value.

**Caveat:** the authenticated code paths were built from the official Kalshi and Polymarket docs and tested with mocks only. They have not been run against the live services. Run once locally with real keys before relying on them, and confirm the Feeds strip shows `ws` for Kalshi as described above. If it shows `(rest)` or the feed is disconnected, the dashboard has fallen back to REST polling and the websocket settings need checking.

## Configuration

All settings come from `.env` (see `.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_TOTAL_COST` | `90` | Max combined leg cost in cents for a tradable combo |
| `CONTRACTS_PER_TRADE` | `10` | Contracts bought per leg per trade |
| `MAX_TRADES_PER_EVENT` | `20` | Max simulated trades per 15-minute window |
| `TRADE_COOLDOWN_MS` | `5000` | Minimum milliseconds between trades |
| `NO_TRADE_LAST_SEC` | `20` | No new trades in the last N seconds of a window |
| `POLL_MS` | `1000` | Market and BTC polling interval in milliseconds |
| `PORT` | `3000` | Dashboard HTTP and WebSocket port |
| `DB_PATH` | `data/sim.sqlite` | SQLite file for simulated trades |
| `KALSHI_BASE_URL` | `https://api.elections.kalshi.com/trade-api/v2` | Kalshi API base URL |
| `POLY_GAMMA_URL` | `https://gamma-api.polymarket.com` | Polymarket Gamma API URL |
| `POLY_CLOB_URL` | `https://clob.polymarket.com` | Polymarket CLOB API URL |
| `KALSHI_API_KEY_ID` | (unset) | Kalshi API key ID. Enables the Kalshi websocket (order book and BRTI) |
| `KALSHI_PRIVATE_KEY_PATH` | (unset) | Path to the Kalshi private key PEM file (`./kalshi_private_key.pem`) |
| `KALSHI_PRIVATE_KEY` | (unset) | Alternative to the path: the PEM inline, newlines written as `\n` |
| `KALSHI_WS_URL` | `wss://external-api-ws.kalshi.com/trade-api/ws/v2` | Kalshi authenticated websocket URL |
| `POLY_API_KEY` | (unset) | Polymarket CLOB API key |
| `POLY_API_SECRET` | (unset) | Polymarket CLOB API secret |
| `POLY_API_PASSPHRASE` | (unset) | Polymarket CLOB API passphrase |
| `POLY_LIVE_WS_URL` | `wss://ws-live-v2.polymarket.com/ws` | Polymarket live-data websocket URL (Chainlink 60s TWAP) |

## Disclaimer

This is a simulation for research and education. It is not financial advice. Real execution would face fees, slippage, partial fills, and the strike-mismatch risk described above.
