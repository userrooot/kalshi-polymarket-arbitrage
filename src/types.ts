// Shared contract between backend (src/) and dashboard (public/index.html).
// All prices are in CENTS (0-100), floats allowed (e.g. 66, 11.5).

export type Side = "UP" | "DOWN";
export type Venue = "kalshi" | "polymarket";

/** Live snapshot of one venue's current 15m BTC event. */
export interface VenueSnapshot {
  venue: Venue;
  marketId: string;          // Kalshi ticker / Polymarket slug
  title: string;
  strike: number | null;     // "price to beat" in USD
  openTime: string;          // ISO
  closeTime: string;         // ISO
  upAsk: number | null;      // cost to BUY Up (cents)
  downAsk: number | null;    // cost to BUY Down (cents)
  upBid: number | null;
  downBid: number | null;
  ts: number;                // ms when fetched
  // live BTC spot matching this venue's resolution source
  spot: number | null;       // USD
  spotSource: "chainlink" | "chainlink-twap" | "cfbenchmarks" | null;
  spotTs: number | null;     // ms received
  spotSettle: number | null; // Kalshi: exact last_60s_windowed_average_15min (final minute only), else null
  spotError: string | null;  // why official spot is missing (e.g. 'no Kalshi API key', 'auth: header_timestamp_expired')
  strikeSource: string | null; // e.g. 'kalshi floor_strike', 'chainlink@window-start', 'polymarket priceToBeat'
  spotAvg60: number | null;  // running mean of spot over last 60s (settlement estimate; Kalshi uses [T-60s,T-1s])
  quoteSource: "ws" | "rest"; // how Up/Down prices were obtained
  quoteAgeMs: number | null;
}

export interface FeedStat { name: string; connected: boolean; msgsPerSec: number; updatesPerSec: number; latencyMs: number | null; lastMsgAgeMs: number | null; reconnects: number }

/** One arbitrage combination: buy `legA` on one venue + `legB` (opposite side) on the other. */
export interface Combo {
  id: "K_UP+P_DOWN" | "K_DOWN+P_UP";
  kalshiSide: Side;
  polySide: Side;
  kalshiAsk: number | null;
  polyAsk: number | null;
  totalCost: number | null;  // kalshiAsk + polyAsk (cents)
  profitIfOneWins: number | null; // 100 - totalCost (cents per contract)
  tradable: boolean;         // totalCost < MAX_TOTAL_COST
}

export type TradeStatus = "OPEN" | "SETTLED";

export interface Trade {
  id: number;
  eventKey: string;          // close time ISO of the 15m window, groups trades of one event
  seq: number;               // 1..MAX_TRADES_PER_EVENT within event
  openedAt: number;          // ms
  combo: Combo["id"];
  kalshiSide: Side;
  polySide: Side;
  kalshiPrice: number;       // cents paid per contract
  polyPrice: number;
  totalCost: number;         // per contract, cents
  contracts: number;
  stakeUsd: number;          // totalCost/100 * contracts
  kalshiStrike: number | null;
  polyStrike: number | null;
  btcAtEntry: number | null;
  // why this trade was taken (human readable)
  entryReason: string;
  status: TradeStatus;
  // filled at settlement
  settledAt?: number;
  kalshiResult?: Side;       // real outcome on Kalshi
  polyResult?: Side;         // real outcome on Polymarket
  kalshiLegWon?: boolean;
  polyLegWon?: boolean;
  payoutUsd?: number;
  pnlUsd?: number;
  // human readable explanation of why profit/loss happened
  outcomeReason?: string;
  btcAtSettle?: number | null;
}

export interface Stats {
  totalTrades: number;
  openTrades: number;
  settledTrades: number;
  wins: number;
  losses: number;
  winRate: number;           // 0-100
  totalPnlUsd: number;
  totalStakeUsd: number;
}

export interface PnlPoint { ts: number; cumPnlUsd: number; tradeId: number }
export interface CostPoint { ts: number; costKUpPDown: number | null; costKDownPUp: number | null }

/** GET /api/state and WS message {type:"state", ...}. */
export interface DashboardState {
  now: number;
  maxTotalCost: number;
  maxTradesPerEvent: number;
  contractsPerTrade: number;
  btcPrice: number | null;
  exec: import("./exec/types.ts").ExecState | null; // realistic execution simulation (null if disabled)
  alerts: string[];          // red banner messages (missing keys, auth failures)
  feeds: FeedStat[];
  tickRate: { ticksPerSec: number; broadcastsPerSec: number };
  kalshi: VenueSnapshot | null;
  polymarket: VenueSnapshot | null;
  combos: Combo[];
  eventKey: string | null;
  tradesThisEvent: number;
  stats: Stats;
  costHistory: CostPoint[];  // last ~15 min, current event
  pnlHistory: PnlPoint[];
  recentTrades: Trade[];     // newest first, max 100
}
// Endpoints: GET /api/state -> DashboardState ; GET /api/trades?limit=200 -> Trade[] ;
// WS /ws sends DashboardState JSON about once per second.
