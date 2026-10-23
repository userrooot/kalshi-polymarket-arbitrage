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

Polymarket prices and spot run on public data without keys. The Kalshi spot panel needs a Kalshi API key, because its only spot source is the official CF Benchmarks BRTI index (see [Spot sources](#spot-sources)). Without a key that panel shows `— no official feed` with the reason, and no estimate is substituted. The other optional websocket settings in `.env.example` add faster feeds (see [Live data & update rates](#live-data--update-rates)).

Keep `.env` and any `*.pem` key file out of git. Both are listed in `.gitignore`. Secrets are never logged.

## Reading the dashboard

- **Header**: connection dot (green live, amber connecting or stale, red disconnected), BTC price, the current event window with a countdown to close, and trades opened in this event versus the limit.
- **Kalshi / Polymarket panels**: market id, strike (price to beat) with its source underneath, the live BTC spot with its official source, Up and Down ask and bid in cents, and time left. The strike shows `—` and `not available yet` until it is published. The spot shows `— no official feed` and the reason when no official feed is available.
- **Alerts banner**: a red banner at the top lists problems such as a missing API key or failed authentication, one per line. Dismiss hides it until the messages change.
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

- **Polymarket spot** comes from Polymarket's RTDS websocket. It is the Chainlink 60s TWAP when `POLY_API_KEY` is set, and plain Chainlink BTC/USD spot otherwise. Polymarket resolves on the TWAP.
- **Kalshi** resolves on the CF Benchmarks BRTI index. The Kalshi panel shows only that official value, streamed over Kalshi's websocket, and it needs `KALSHI_API_KEY_ID` and a private key. Without keys it shows `— no official feed` and never estimates the index. When Kalshi publishes its final-minute value, a highlighted `Settlement value (final minute)` row appears.
- **Up/Down prices** for Polymarket are pushed over the CLOB websocket. For Kalshi they come from REST polling every `KALSHI_BOOK_POLL_MS` (350 ms by default), unless a Kalshi API key websocket is configured.
- Each panel shows where its quotes came from (`WS push` or `REST`) and how old they are. A spot price older than 5 s is grayed out and marked stale.
- The Feeds strip shows, per feed: connection status, messages/s, price updates/s, latency and last-message age. Below the feeds, a summary line gives the Kalshi and Polymarket Up/Down updates/s, with `(ws)` or `(rest)` for how Kalshi quotes arrive. Tick and broadcast rates are at the right.

### With and without keys

| | Without API keys | With API keys |
| --- | --- | --- |
| Kalshi Up/Down prices | REST poll every `KALSHI_BOOK_POLL_MS` (350 ms default), shown as `REST` | Kalshi websocket push, shown as `WS push` (`kalshiBookWs` feed) |
| Kalshi spot (settles on BRTI) | `— no official feed` with the reason, no estimate | CF Benchmarks BRTI (official), via the Kalshi websocket |
| Polymarket Up/Down prices | CLOB websocket push | CLOB websocket push (same) |
| Polymarket spot (resolves on Chainlink) | Chainlink BTC/USD spot, not TWAP | Chainlink 60s TWAP via Polymarket's live-data websocket (the actual resolution source) |

Without keys both venues still price on public data, but the Kalshi spot panel has no official feed. The authenticated websockets are strongly recommended, because they supply the Kalshi spot and remove most of the polling delay on Kalshi.

### Spot sources

- **Kalshi** resolves on the CF Benchmarks BRTI index. The only spot shown on the Kalshi panel is that official index, `CF Benchmarks BRTI (official, Kalshi websocket)`, streamed over Kalshi's authenticated websocket (`cfbenchmarks_value`). It needs `KALSHI_API_KEY_ID` and a private key (`KALSHI_PRIVATE_KEY_PATH` or `KALSHI_PRIVATE_KEY`). If the feed is missing, the panel shows `— no official feed` and the reason, for example `no Kalshi API key`. The dashboard does not substitute an average of other exchanges.
- **Polymarket** resolves on the Chainlink BTC/USD 60s TWAP. With `POLY_API_KEY`, `POLY_API_SECRET` and `POLY_API_PASSPHRASE`, the TWAP is streamed via Polymarket's live-data websocket (`Chainlink 60s TWAP (Polymarket resolution source)`). Without them, the Polymarket price shows 'no official feed' (plain Chainlink spot is not the resolution price, so it is not shown).
- **Price to beat (strike)**: Kalshi uses the market's `floor_strike`. Polymarket uses the Chainlink price at window start. Each panel shows its source under the strike. The spot-minus-strike figure appears only when both the spot and the strike are known.
- Each panel shows exactly ONE live price: the one its venue resolves on. Kalshi: the 60s average of BRTI that Kalshi computes server-side (`avg_60s_data`, the bot only reads it). Polymarket: the Chainlink 60s TWAP streamed by Polymarket (requires Polymarket API creds). The bot never averages prices itself; without the official feed the panel shows 'no official feed'.

### Enabling the authenticated websockets

1. Create a Kalshi API key and download its private key PEM. Save it as `kalshi_private_key.pem` in the repo root, or use `KALSHI_PRIVATE_KEY` inline.
2. Create Polymarket CLOB API credentials (key, secret, passphrase).
3. Fill in the commented-out variables in `.env` (see `.env.example`), then restart with `bun run start`.
4. Open the dashboard and check the Feeds strip. The Kalshi summary should read `Kalshi Up/Down updates/s: … (ws)`, and the `kalshiBookWs` row should show `connected` with a latency value. The Kalshi spot panel should show `CF Benchmarks BRTI (official, Kalshi websocket)` with a price, not `— no official feed`.

**Caveat:** the authenticated code paths were built from the official Kalshi and Polymarket docs and tested with mocks only. They have not been run against the live services. Run once locally with real keys before relying on them, and confirm the Feeds strip shows `ws` for Kalshi as described above. If it shows `(rest)` or the feed is disconnected, the dashboard has fallen back to REST polling and the websocket settings need checking.

## Execution realism & UK colocation study

The instant-fill model above is optimistic: it assumes both legs fill at the top-of-book ask at the moment the signal appears. The execution layer asks the questions that matter before any real money is risked: would the orders have filled, how fast, does the opportunity still exist when they arrive, and does a faster server (for example one in the UK) pay off?

The layer is on by default (`EXEC_SIM=1`). The dashboard section is hidden when it is off.

### What is simulated

- **Depth history**: full order book depth per Kalshi market and per Polymarket token, kept for `BOOK_HISTORY_MIN` minutes.
- **Opportunity episodes**: a stretch of time during which buying a set size on both legs costs less than `MAX_TOTAL_COST`, with enough depth. Each episode records its start, end and lifetime, and what ended it (`killedBy`: a Kalshi leg, a Polymarket leg, both, a stale quote or a window rollover).
- **Fill at arrival**: an order is priced against the book as it is when the order would arrive, which is the decision time plus feed delay, one-way send latency and venue processing. It walks the asks up to the limit (ask plus `SLIPPAGE_TICKS`). Levels that changed within `RACE_WINDOW_MS` count as taken. An extra `P_LOSE_RACE` share of orders is lost when the opportunity died right after arrival. That race loss is a guess, which is why it is a setting and not a measurement.
- **Strategies**: `NAIVE` (the instant-fill baseline), `PAR` (both legs at once), `K_THEN_P` (Kalshi first, Polymarket after the Kalshi ack) and `P_THEN_K` (the reverse). When only one leg fills, the other is retried once. A filled leg that is still unhedged is then unwound: at the bid (`UNWIND_MODE=bid`) after `UNWIND_AFTER_MS`, or held (`hold`). Unwound legs get real PnL.
- **Latency**: feed delay, send, venue processing and ack are sampled from a latency profile. The profile is either the default (assumed values) or measured (`data/latency.json`, written by `bun run probe`).
- **Fees** (optional, `FEES_ON=1`): estimated taker fee formulas. They are unverified (see limitations), so they are off by default.

### How to read the section

- **Status strip**: the latency profile source. `default` shows a warning, because the numbers are assumed. The depth quality per venue: `rest-coarse` for Kalshi shows an amber warning, because Kalshi episode lifetimes are biased long without websocket depth. The recorder: messages, size and file.
- **Opportunity lifetime**: a histogram of recent closed episodes in log-millisecond bins, with p50, p95 and p99 and counts of episodes and open episodes. The **survival curve** is P(lifetime > L): the share of episodes still alive after L ms, with markers at 5 to 500 ms. Read it as "at 50 ms, X% of the opportunities are still there". **Killed by** shows which condition ended episodes most often. A Kalshi-side kill means the cheap Kalshi leg vanished first.
- **Strategy comparison**: per strategy, the fill rate on each venue, the rate that both legs filled, the rate with one leg only, and the rate with none. Time to fill is shown as p50 / p95 / p99 in ms for each venue and for both legs. Expected PnL per attempt is highlighted for the best strategy, along with average slippage. Do not compare on PnL alone: a strategy with high PnL and a high one-leg rate depends on the unwind assumption.
- **Fill rate vs assumed latency**: the both-legs and Kalshi-only fill rates as the assumed latency is swept. This comes from `bun run replay`. Colocation pays off where the both-legs curve stays high at the latency you can actually get.
- **Attempts**: pick a strategy and click an attempt. Its timeline shows, per leg, the decision, the send, the arrival and the ack, as horizontal bars. The asks seen at decision and at arrival are shown next to each other, with the miss reason when a leg did not fill (`price_moved`, `depth_consumed`, `race_lost`, `no_book`, `below_min_size`, `fok_incomplete`). The outcome badge is BOTH, ONE or NONE, followed by the unwind PnL when a leg was unwound. The decision time is the backend's `decisionAt` when it is present, and otherwise the first send.
- **Limitations**: the list of what this layer does not model. Read it with the numbers.

### Workflow

1. **Run anywhere (cloud container, laptop)**: `bun run start` as usual. Latencies are defaults and Kalshi depth is REST-coarse. This checks that the pipeline works and gives a rough picture. The numbers are estimates.
2. **On the UK server**:
   - Keep the clock tight: install and enable chrony and check that `chronyc tracking` shows an offset of about 1 ms or less. A clock skew of a few milliseconds is as large as Polymarket's latency, so one-way timestamps are not trustworthy without it.
   - Run `bun run probe`. It measures round-trip times to both venues and writes `data/latency.json`. The Latency profile chip then reads `probe`.
   - Set `RECORD_MD=1` and let it run for days, a week if possible. Raw market data is written to `MD_DIR`, and the recorder deletes the oldest files once `MD_RETENTION_GB` is reached.
3. **Decide whether colocation pays**: `bun run replay --lat-k 5..300 --lat-p 5..50` replays the recorded data through the same fill logic with a virtual clock, once for each combination of Kalshi and Polymarket latency. It writes a CSV of the both-fill rate and PnL per cell. Kalshi's servers are in the US, so the Kalshi one-way latency from the UK is probably around 80 to 120 ms. That is an assumption until the probe measures it. If both-fill rate and PnL hold up at the Kalshi latency you measure, colocation is worth it. If they collapse there, it is not.
4. **Optional: Kalshi demo, then real-money calibration**:
   - With `KALSHI_DEMO_API_KEY_ID` and `KALSHI_DEMO_PRIVATE_KEY_PATH` set, `bun run probe` also measures order round trips on Kalshi's demo environment, which uses mock funds. Whether the demo accepts orders the way production does is not verified. Check the probe output before trusting it.
   - `CALIBRATE_LIVE=1` is off by default and **uses real money**. It needs a typed confirmation. It sends tiny orders that should not fill (on Kalshi, a fraction of a contract at least 10¢ below the ask; on Polymarket, a fill-or-kill order at minimum size far below the ask), only to measure round-trip time. It never leaves resting orders and sends at most one probe every 10 seconds. These orders are designed not to fill, but a sudden price move could fill them. Read the warning in `.env.example` first.

### Limitations

These are shown on the dashboard too.

- The layer cannot see real queue position, hidden orders or other bots racing for the same level. Race loss is modelled with `RACE_WINDOW_MS` and `P_LOSE_RACE`, which are guesses, not measurements.
- Our own order's market impact is ignored.
- Venue timestamps have different meanings, and clock skew of a few milliseconds is as large as Polymarket's latency. Trust measured round-trip times over one-way estimates.
- Without Kalshi websocket depth, Kalshi depth is coarse (REST). Kalshi episode lifetimes are then biased long.
- The demo environment is not production. Fills, latency and fees differ.
- Long-lived "opportunities" are disproportionately stale or false, because of strike or source mismatches. They inflate the tail of the survival curve.
- Fee formulas are unverified, and Polymarket's fee and delay rules change without notice. `FEES_ON` is `0` by default.
- Simulation results are estimates, not guarantees.

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
| `KALSHI_API_KEY_ID` | (unset) | Kalshi API key ID. Required for the official BRTI spot. Also enables the Kalshi websocket (order book) |
| `KALSHI_PRIVATE_KEY_PATH` | (unset) | Path to the Kalshi private key PEM file (`./kalshi_private_key.pem`) |
| `KALSHI_PRIVATE_KEY` | (unset) | Alternative to the path: the PEM inline, newlines written as `\n` |
| `KALSHI_WS_URL` | `wss://external-api-ws.kalshi.com/trade-api/ws/v2` | Kalshi authenticated websocket URL |
| `POLY_API_KEY` | (unset) | Polymarket CLOB API key |
| `POLY_API_SECRET` | (unset) | Polymarket CLOB API secret |
| `POLY_API_PASSPHRASE` | (unset) | Polymarket CLOB API passphrase |
| `POLY_LIVE_WS_URL` | `wss://ws-live-v2.polymarket.com/ws` | Polymarket live-data websocket URL (Chainlink 60s TWAP) |
| `EXEC_SIM` | `1` | Turns the execution realism layer on (`1`) or off (`0`). Off hides the dashboard section |
| `EXEC_PRIMARY` | `NAIVE` | Strategy whose fills drive the headline PnL: `NAIVE`, `PAR`, `K_THEN_P` or `P_THEN_K` |
| `SLIPPAGE_TICKS` | `1` | How many price ticks above the observed ask a leg may walk when it fills |
| `RACE_WINDOW_MS` | `2` | Levels that change within this window before arrival count as already taken |
| `P_LOSE_RACE` | `0.3` | Extra share of orders lost to a race when the opportunity died within 20 ms of arrival. A guess, swept in replay |
| `UNWIND_MODE` | `bid` | What happens to an unhedged leg: `bid` sells it at the bid, `hold` keeps it to settlement |
| `UNWIND_AFTER_MS` | `500` | Wait this long after a one-leg fill before unwinding it |
| `FEES_ON` | `0` | `1` applies the estimated taker fee formulas (unverified, see the limitations) |
| `BOOK_HISTORY_MIN` | `20` | Minutes of full order book depth kept per market for the simulator |
| `LAT_PROFILE` | `data/latency.json` | Latency profile written by `bun run probe`. Missing file means the assumed defaults |
| `LAT_KALSHI_MS` | (unset) | Overrides the Kalshi one-way latency, in ms, instead of the profile. Used for what-if runs |
| `LAT_POLY_MS` | (unset) | Overrides the Polymarket one-way latency, in ms, instead of the profile |
| `EXEC_SEED` | (unset) | Seed for the simulator's random latency and race draws. Set it for reproducible runs |
| `RECORD_MD` | `0` | `1` records raw market data (both timestamps) to `MD_DIR` for replay. Needs disk space |
| `MD_DIR` | `data/md` | Directory for recorded market data files |
| `MD_RETENTION_GB` | `20` | The recorder deletes the oldest files once this size is reached |
| `KALSHI_DEMO_API_KEY_ID` | (unset) | Kalshi demo environment API key ID (mock funds). Used by `bun run probe` for order round trips |
| `KALSHI_DEMO_PRIVATE_KEY_PATH` | (unset) | Path to the PEM private key for the Kalshi demo key |
| `KALSHI_DEMO_BASE_URL` | `https://external-api.demo.kalshi.co/trade-api/v2` | Kalshi demo API base URL |
| `CALIBRATE_LIVE` | `0` | **Real money.** `1` enables the opt-in live round-trip probe, after a typed confirmation. See the calibration step above |

## Disclaimer

This is a simulation for research and education. It is not financial advice. Real execution would face fees, slippage, partial fills, and the strike-mismatch risk described above.
