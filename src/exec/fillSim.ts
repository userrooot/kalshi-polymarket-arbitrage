// PURE leg-fill simulator: no I/O, deterministic given (history, samples, opts). Decides whether ONE order would have filled
// by looking at the book as it was when the order ARRIVED at the venue:
//   arrival = sentAt + sendOneWay + venue processing (+ Polymarket secondsDelay)
//   book    = BookHistory.at(venue, key, arrival)               (last event with venue-time <= arrival)
//   limit   = seenAsk + SLIPPAGE_TICKS on the venue's price grid  (IOC: partial fills ok, FOK: all-or-none)
//   race    = a level that SHRANK within RACE_WINDOW_MS after arrival counts as taken by someone faster; if the best level shrank
//             within 20ms of arrival we additionally lose it with probability P_LOSE_RACE (both are GUESSES, report a range)
//   ack     = arrival + ackOneWay
import type { Venue } from "../types.ts";
import { config } from "../config.ts";
import { addTicks, roundToTick, type TickFn } from "./ticks.ts";
import type { BookHistory } from "./bookHistory.ts";
import type { LegSamples } from "./latency.ts";
import type { Level, LegFill, LegOrder, SideBook, VenueDepth, VenueLatency } from "./types.ts";

export interface ExecOpts {
  slippageTicks: number;
  raceWindowMs: number;
  pLoseRace: number;
  /** "best level changed within this many ms after arrival" triggers the P_LOSE_RACE draw. */
  raceDieMs: number;
  feesOn: boolean;
  unwindMode: "bid" | "hold";
  unwindAfterMs: number;
  orderType: "IOC" | "FOK";
}
export function execOptsFromConfig(over: Partial<ExecOpts> = {}): ExecOpts {
  return {
    slippageTicks: config.slippageTicks, raceWindowMs: config.raceWindowMs, pLoseRace: config.pLoseRace, raceDieMs: 20,
    feesOn: config.feesOn, unwindMode: config.unwindMode, unwindAfterMs: config.unwindAfterMs, orderType: "IOC", ...over,
  };
}

const EPS = 1e-9;
export const sideBook = (d: VenueDepth, side: "UP" | "DOWN"): SideBook => (side === "UP" ? d.up : d.down);
export const bestAsk = (d: VenueDepth | null, side: "UP" | "DOWN"): number | null => (d ? sideBook(d, side).asks.find((l) => l.size > 0)?.price ?? null : null);
export const bestBid = (d: VenueDepth | null, side: "UP" | "DOWN"): number | null => (d ? sideBook(d, side).bids.find((l) => l.size > 0)?.price ?? null : null);

/** Limit price for a BUY: seen ask moved up `ticks` grid steps (grid-rounded, capped at 99.9). */
export function limitPrice(seenAsk: number, tick: TickFn, ticks: number): number {
  return Math.min(99.9, addTicks(roundToTick(seenAsk, tick, "up"), ticks, tick));
}

/** Walk ascending asks up to `limit`; returns filled qty and total cost (cents). */
export function walkAsks(levels: Level[], limit: number, qty: number): { qty: number; cost: number } {
  let q = 0, cost = 0;
  for (const l of levels) {
    if (l.price > limit + EPS) break;
    if (l.size <= 0) continue;
    const take = Math.min(l.size, qty - q);
    q += take; cost += take * l.price;
    if (q >= qty - EPS) break;
  }
  return { qty: q, cost };
}
/** Walk descending bids (selling `qty`); returns sold qty and proceeds (cents). */
export function walkBids(levels: Level[], qty: number): { qty: number; proceeds: number } {
  let q = 0, p = 0;
  for (const l of levels) {
    if (l.size <= 0) continue;
    const take = Math.min(l.size, qty - q);
    q += take; p += take * l.price;
    if (q >= qty - EPS) break;
  }
  return { qty: q, proceeds: p };
}

/** Taker fee in cents for a whole fill. FORMULAS UNVERIFIED (see README): Polymarket crypto C*0.07*p(1-p) (applicability to 15m markets unknown);
 *  Kalshi ceil(0.07*C*P*(1-P)) rounded UP to the cent. Only applied when FEES_ON=1. */
export function feeCents(venue: Venue, qty: number, priceCents: number): number {
  const p = priceCents / 100;
  const dollars = 0.07 * qty * p * (1 - p);
  return venue === "kalshi" ? Math.ceil(dollars * 100 - 1e-9) : Math.round(dollars * 100 * 100) / 100;
}

/** ownTaken: shares we already bought on this venue earlier in the same attempt; the (unchanged) history does not know that
 *  liquidity is gone, so a retry skips that many shares off the front of the ladder (own market impact, conservative). */
export interface LegCtx { key: string; sentAt: number; seenAsk: number | null; samples: LegSamples; ownTaken?: number }

const decreased = (lv: Level[], price: number, size: number) => {
  const m = lv.find((l) => Math.abs(l.price - price) < EPS);
  return !m || m.size < size - EPS;
};

/** Simulate one BUY order. `order.limitPrice` is used as given (build it with limitPrice()). */
export function simulateLeg(order: LegOrder, ctx: LegCtx, history: BookHistory, lat: VenueLatency, opts: ExecOpts): LegFill {
  const { venue, side, qty } = order;
  const s = ctx.samples;
  const delay = lat.secondsDelayMs ?? history.latest(venue, ctx.key)?.depth.secondsDelayMs ?? 0;
  const arriveAt = ctx.sentAt + s.sendMs + s.processMs + delay;
  const ackAt = arriveAt + s.ackMs;
  const base: LegFill = { venue, side, status: "MISS", qty: 0, vwap: null, fee: 0, sentAt: ctx.sentAt, arriveAt, ackAt, seenAsk: ctx.seenAsk, arrivalAsk: null };

  const depth = history.at(venue, ctx.key, arriveAt);
  if (!depth) return { ...base, missReason: "no_book" };
  const sb = sideBook(depth, side);
  base.arrivalAsk = bestAsk(depth, side);
  if (qty < depth.minSize - EPS) return { ...base, missReason: "below_min_size" };

  const eligible = sb.asks.filter((l) => l.size > 0 && l.price <= order.limitPrice + EPS);
  const avail0 = eligible.reduce((a, l) => a + l.size, 0);

  // race haircut: levels that shrank within RACE_WINDOW_MS after arrival were taken by someone faster
  const later = history.between(venue, ctx.key, arriveAt, arriveAt + Math.max(opts.raceWindowMs, opts.raceDieMs));
  const laterSide = later.map((e) => ({ t: e.t, asks: sideBook(e.depth, side).asks }));
  let levels = eligible.filter((l) => !laterSide.some((e) => e.t <= arriveAt + opts.raceWindowMs && decreased(e.asks, l.price, l.size)));
  if (levels.length) {
    const best = levels[0]!;
    const died = laterSide.some((e) => e.t <= arriveAt + opts.raceDieMs && decreased(e.asks, best.price, best.size));
    if (died && s.raceU < opts.pLoseRace) levels = levels.slice(1);
  }

  if (ctx.ownTaken && ctx.ownTaken > EPS) {
    let skip = ctx.ownTaken;
    levels = levels.map((l) => { const t = Math.min(l.size, skip); skip -= t; return { ...l, size: l.size - t }; }).filter((l) => l.size > EPS);
  }
  const walk = walkAsks(levels, order.limitPrice, qty);
  const fail = (): LegFill["missReason"] => {
    if (avail0 <= EPS) return "price_moved";
    if (avail0 - (ctx.ownTaken ?? 0) < qty - EPS && avail0 >= qty - EPS) return "depth_consumed";
    if (avail0 < qty - EPS) return order.type === "FOK" ? "fok_incomplete" : "depth_consumed";
    return "race_lost";
  };
  if (order.type === "FOK" && walk.qty < qty - EPS) return { ...base, missReason: fail() };
  if (walk.qty <= EPS) return { ...base, missReason: fail() };
  const vwap = walk.cost / walk.qty;
  const full = walk.qty >= qty - EPS;
  return {
    ...base, status: full ? "FILLED" : "PARTIAL", qty: walk.qty, vwap,
    fee: opts.feesOn ? feeCents(venue, walk.qty, vwap) : 0,
    ...(full ? {} : { missReason: avail0 < qty - EPS ? ("depth_consumed" as const) : ("race_lost" as const) }),
  };
}
