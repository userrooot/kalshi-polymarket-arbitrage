// Contract for the realistic-execution layer (shared by engine, replay, probe, dashboard).
// Prices in CENTS (0-100, floats allowed), sizes in contracts/shares. Times in ms since epoch (float ok).
import type { Side, Venue } from "../types.ts";

export interface Level { price: number; size: number }

/** Full ask/bid depth for BUYING each side on one venue (asks ascending, bids descending). */
export interface SideBook { asks: Level[]; bids: Level[] }
/** Depth for one venue's current market: Up and Down are separate books (Kalshi: derived from YES/NO bids). */
export interface VenueDepth { up: SideBook; down: SideBook; tick: (price: number) => number /* grid step at that price */; minSize: number }

export interface DepthEvent {
  venue: Venue;
  key: string;               // Kalshi ticker / Polymarket slug
  venueTs: number | null;    // venue-side event time (ms), null if unknown
  recvTs: number;            // local receive time (ms, high-res epoch)
  depth: VenueDepth;
}

/** Latency profile: per-component empirical samples (ms). Loaded from data/latency.json (written by probe) or defaults. */
export interface LatencyComponent { kind: "lognormal" | "empirical"; medianMs?: number; sigma?: number; samples?: number[] }
export interface VenueLatency {
  feedDelay: LatencyComponent;   // recv - venueTs (clock-offset corrected)
  sendOneWay: LatencyComponent;  // order send -> arrival at venue
  process: LatencyComponent;     // matching/processing at venue
  ackOneWay: LatencyComponent;   // venue -> us
  secondsDelayMs?: number;       // Polymarket per-market matching delay if any
}
export interface LatencyProfile { kalshi: VenueLatency; polymarket: VenueLatency; source: "default" | "probe" | "override" }

export type OrderType = "IOC" | "FOK";
export interface LegOrder { venue: Venue; side: Side; type: OrderType; qty: number; limitPrice: number }
export type LegStatus = "FILLED" | "PARTIAL" | "MISS";
export interface LegFill {
  venue: Venue; side: Side; status: LegStatus;
  qty: number; vwap: number | null; fee: number;     // fee in cents per whole fill (0 when FEES_ON=0)
  sentAt: number; arriveAt: number; ackAt: number;   // venue-time/ local ms on a common timeline
  seenAsk: number | null;                            // best ask when decided
  arrivalAsk: number | null;                         // best ask at arrival
  missReason?: "price_moved" | "depth_consumed" | "race_lost" | "no_book" | "below_min_size" | "fok_incomplete";
}

export type StrategyId = "NAIVE" | "PAR" | "K_THEN_P" | "P_THEN_K";
export interface AttemptResult {
  strategy: StrategyId;
  kalshi: LegFill; poly: LegFill;
  outcome: "BOTH" | "ONE" | "NONE";
  hedgedQty: number;                    // min(filled qty)
  timeToBothMs: number | null;
  retried: boolean;
  unwound: boolean; unwindPnlCents: number | null;
}

export interface Episode {
  id: number;
  combo: "K_UP+P_DOWN" | "K_DOWN+P_UP";
  eventKey: string;
  startVenueTs: number | null; endVenueTs: number | null;
  startRecv: number; endRecv: number | null;
  durationMs: number | null;            // local-time duration; null while open
  maxEdgeCents: number; maxSize: number;
  killedBy: "kalshi" | "poly" | "both" | "stale" | "rollover" | null;
  killReason: "price_moved" | "depth_consumed" | "stale" | "rollover" | null;
  censored: boolean;
}

export interface Dist { n: number; p50: number | null; p95: number | null; p99: number | null; mean: number | null }
export interface SurvivalPoint { ms: number; share: number }          // share of episodes lasting > ms
export interface StrategyStats {
  strategy: StrategyId; attempts: number;
  kalshiFillRate: number; polyFillRate: number; bothRate: number; oneLegRate: number; noneRate: number;
  kalshiFillMs: Dist; polyFillMs: Dist; bothMs: Dist;
  expPnlPerAttemptUsd: number; avgSlippageCents: number;
}
export interface FillLatencyCurvePoint { latencyMs: number; bothRate: number; kalshiFillRate: number }

export interface ExecState {
  enabled: boolean;
  profileSource: LatencyProfile["source"];
  depthQuality: { kalshi: "ws" | "rest-coarse" | "none"; polymarket: "ws" | "none" };
  recorder: { enabled: boolean; msgs: number; bytes: number; file: string | null };
  episodes: { total: number; open: number; durationMs: Dist; survival: SurvivalPoint[]; killedBy: Record<string, number>; recent: Episode[] };
  strategies: StrategyStats[];
  fillLatencyCurve: FillLatencyCurvePoint[];   // from last replay or live sweep (may be empty)
  recentAttempts: AttemptResult[];             // newest first, max 50 (all strategies of the latest trades)
  limitations: string[];
}
