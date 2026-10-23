// Order-sequencing strategies on top of fillSim. All strategies of one decision share the same latency samples
// (AttemptSamples) so differences between them are due to sequencing, not luck.
//   NAIVE    instant fill of both legs at the seen asks (the old simulator; baseline)
//   PAR      both legs sent at t0
//   K_THEN_P Kalshi first; Polymarket sent when the Kalshi ack arrives (for the filled qty)
//   P_THEN_K Polymarket first; Kalshi sent when the Polymarket ack arrives
// A leg that comes up short is retried ONCE at the then-current ask if the edge is still >= 0; whatever stays unhedged is
// unwound at the best bid after UNWIND_AFTER_MS (UNWIND_MODE=bid) or held to settlement (hold).
import type { Venue } from "../types.ts";
import { dist, round2 } from "./dist.ts";
import { bestAsk, bestBid, execOptsFromConfig, feeCents, limitPrice, simulateLeg, walkBids, type ExecOpts } from "./fillSim.ts";
import type { BookHistory } from "./bookHistory.ts";
import { mulberry32, sampleAttempt, type AttemptSamples, type LegSamples } from "./latency.ts";
import { defaultKalshiTick, type TickFn } from "./ticks.ts";
import type { AttemptResult, Episode, LatencyProfile, LegFill, LegOrder, StrategyId, StrategyStats } from "./types.ts";

export const STRATEGIES: StrategyId[] = ["NAIVE", "PAR", "K_THEN_P", "P_THEN_K"];
const EPS = 1e-9;

export interface Decision {
  combo: Episode["combo"];
  qty: number;
  decidedAt: number;                       // local ms when the bot decided (== when it saw the triggering book)
  kalshi: { key: string; side: "UP" | "DOWN"; seenAsk: number };
  poly: { key: string; side: "UP" | "DOWN"; seenAsk: number };
  source?: "trade" | "episode";
  tradeId?: number | null;
}
export interface AttemptOpts extends Partial<ExecOpts> { rng?: () => number; seed?: number; samples?: AttemptSamples }

const venueOf = (isK: boolean): Venue => (isK ? "kalshi" : "polymarket");
const notSent = (venue: Venue, side: "UP" | "DOWN", at: number, seenAsk: number | null): LegFill =>
  ({ venue, side, status: "MISS", qty: 0, vwap: null, fee: 0, sentAt: at, arriveAt: at, ackAt: at, seenAsk, arrivalAsk: null, missReason: "not_sent" });

/** Merge a retry fill into the first fill of the same leg. `target` = total qty wanted on this leg. */
function merge(a: LegFill, b: LegFill, target: number): LegFill {
  const q = a.qty + b.qty;
  const vwap = q > EPS ? ((a.vwap ?? 0) * a.qty + (b.vwap ?? 0) * b.qty) / q : null;
  return {
    ...a, qty: q, vwap, fee: a.fee + b.fee, ackAt: Math.max(a.ackAt, b.ackAt),
    status: q >= target - EPS ? "FILLED" : q > EPS ? "PARTIAL" : "MISS",
    missReason: q >= target - EPS ? undefined : a.missReason ?? b.missReason,
  };
}

export function runAttempt(strategyId: StrategyId, d: Decision, history: BookHistory, latency: LatencyProfile, opts: AttemptOpts = {}): AttemptResult {
  const o = execOptsFromConfig(opts);
  const S = opts.samples ?? sampleAttempt(latency, opts.rng ?? mulberry32(opts.seed ?? 1));
  const t0 = d.decidedAt;
  const edgeCents = 100 - d.kalshi.seenAsk - d.poly.seenAsk;
  const base = { strategy: strategyId, combo: d.combo, qty: d.qty, decidedAt: t0, edgeCents, source: d.source ?? "trade", tradeId: d.tradeId ?? null } as const;

  if (strategyId === "NAIVE") {
    const mk = (venue: Venue, side: "UP" | "DOWN", px: number): LegFill =>
      ({ venue, side, status: "FILLED", qty: d.qty, vwap: px, fee: o.feesOn ? feeCents(venue, d.qty, px) : 0, sentAt: t0, arriveAt: t0, ackAt: t0, seenAsk: px, arrivalAsk: px });
    const k = mk("kalshi", d.kalshi.side, d.kalshi.seenAsk), p = mk("polymarket", d.poly.side, d.poly.seenAsk);
    return { ...base, kalshi: k, poly: p, outcome: "BOTH", hedgedQty: d.qty, timeToBothMs: 0, retried: false, unwound: false, unwindPnlCents: null, expPnlUsd: round2((d.qty * edgeCents - k.fee - p.fee) / 100) };
  }

  const tickOf = (venue: Venue, key: string): TickFn => history.latest(venue, key)?.depth.tick ?? defaultKalshiTick;
  const legInfo = (v: Venue) => (v === "kalshi" ? d.kalshi : d.poly);
  const lat = (v: Venue) => latency[v];
  const sm = (v: Venue, retry: boolean): LegSamples => (v === "kalshi" ? (retry ? S.kalshiRetry : S.kalshi) : retry ? S.polyRetry : S.poly);

  /** Send one order with a fresh view of the ask (what the bot can see locally at `sentAt`); null if there is nothing to hit / edge < 0. */
  const send = (v: Venue, qty: number, sentAt: number, retry: boolean, otherVwap: number | null, ownTaken = 0): LegFill | null => {
    const li = legInfo(v);
    let seen = li.seenAsk;
    if (sentAt > t0 + EPS || otherVwap !== null) {
      seen = bestAsk(history.at(v, li.key, sentAt, "recv"), li.side) ?? NaN;
      if (!Number.isFinite(seen)) return null;
      if (otherVwap !== null && otherVwap + seen > 100 + EPS) return null; // edge gone: do not chase
    }
    const tick = tickOf(v, li.key);
    const order: LegOrder = { venue: v, side: li.side, type: o.orderType, qty, limitPrice: limitPrice(seen, tick, o.slippageTicks) };
    return simulateLeg(order, { key: li.key, sentAt, seenAsk: seen, samples: sm(v, retry), ownTaken }, history, lat(v), o);
  };

  let k: LegFill, p: LegFill;
  if (strategyId === "PAR") {
    k = send("kalshi", d.qty, t0, false, null)!; p = send("polymarket", d.qty, t0, false, null)!;
  } else {
    const firstV: Venue = strategyId === "K_THEN_P" ? "kalshi" : "polymarket", secondV = venueOf(firstV !== "kalshi");
    const first = send(firstV, d.qty, t0, false, null)!;
    let second: LegFill;
    if (first.qty > EPS) second = send(secondV, first.qty, first.ackAt, false, first.vwap) ?? notSent(secondV, legInfo(secondV).side, first.ackAt, legInfo(secondV).seenAsk);
    else second = notSent(secondV, legInfo(secondV).side, first.ackAt, legInfo(secondV).seenAsk);
    [k, p] = firstV === "kalshi" ? [first, second] : [second, first];
  }

  // hedge retry (once) on the short leg
  let retried = false;
  if (Math.abs(k.qty - p.qty) > EPS) {
    const shortV: Venue = k.qty < p.qty ? "kalshi" : "polymarket";
    const longLeg = shortV === "kalshi" ? p : k, shortLeg = shortV === "kalshi" ? k : p;
    const need = longLeg.qty - shortLeg.qty;
    const sentAt = Math.max(k.missReason === "not_sent" ? 0 : k.ackAt, p.missReason === "not_sent" ? 0 : p.ackAt);
    const r = need > EPS ? send(shortV, need, sentAt, true, longLeg.vwap, shortLeg.qty) : null;
    if (r) {
      retried = true;
      if (shortV === "kalshi") k = merge(k, r, d.qty); else p = merge(p, r, d.qty);
    }
  }

  const hedgedQty = Math.min(k.qty, p.qty);
  const outcome: AttemptResult["outcome"] = hedgedQty >= d.qty - EPS ? "BOTH" : k.qty <= EPS && p.qty <= EPS ? "NONE" : "ONE";
  const sentLegs = [k, p].filter((l) => l.missReason !== "not_sent" || l.qty > 0);
  const doneAt = Math.max(...sentLegs.map((l) => l.ackAt), t0);

  // unhedged remainder: unwind at the best bid after UNWIND_AFTER_MS, or hold
  let unwound = false, unwindPnlCents: number | null = null, markCents = 0;
  const excessV: Venue | null = k.qty - p.qty > EPS ? "kalshi" : p.qty - k.qty > EPS ? "polymarket" : null;
  if (excessV) {
    const leg = excessV === "kalshi" ? k : p, li = legInfo(excessV);
    const excess = leg.qty - hedgedQty;
    const s = sm(excessV, false);
    const at = doneAt + o.unwindAfterMs + s.sendMs + s.processMs;
    const bids = history.at(excessV, li.key, at);
    const sb = bids ? (li.side === "UP" ? bids.up.bids : bids.down.bids) : [];
    const w = walkBids(sb, excess);
    const sellFee = o.feesOn && w.qty > 0 ? feeCents(excessV, w.qty, w.proceeds / w.qty) : 0;
    const pnl = w.proceeds - excess * (leg.vwap ?? 0) - sellFee; // unsold part is written off
    if (o.unwindMode === "bid") { unwound = true; unwindPnlCents = round2(pnl); }
    else markCents = pnl; // mark-to-bid for the expectation only
  }
  const hedgeEdge = hedgedQty > EPS ? hedgedQty * (100 - (k.vwap ?? 0) - (p.vwap ?? 0)) : 0;
  const fees = k.fee + p.fee;
  const expPnlUsd = round2((hedgeEdge - fees + (unwound ? unwindPnlCents! : markCents)) / 100);
  const timeToBothMs = outcome === "BOTH" ? round2(Math.max(k.ackAt, p.ackAt) - t0) : null;
  return { ...base, kalshi: k, poly: p, outcome, hedgedQty, timeToBothMs, retried, unwound, unwindPnlCents, expPnlUsd };
}

/** Run all four strategies on one decision with the SAME latency samples. */
export function runAll(d: Decision, history: BookHistory, latency: LatencyProfile, opts: AttemptOpts = {}): AttemptResult[] {
  const samples = opts.samples ?? sampleAttempt(latency, opts.rng ?? mulberry32(opts.seed ?? 1));
  return STRATEGIES.map((s) => runAttempt(s, d, history, latency, { ...opts, samples }));
}

// ---------------------------------------------------------------- aggregation
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 10000) / 10000 : 0);
export function strategyStats(attempts: AttemptResult[], strategy?: StrategyId): StrategyStats {
  const a = strategy ? attempts.filter((x) => x.strategy === strategy) : attempts;
  const id = strategy ?? a[0]?.strategy ?? "NAIVE";
  const n = a.length;
  const fillMs = (sel: (x: AttemptResult) => LegFill) => dist(a.filter((x) => sel(x).qty > EPS).map((x) => sel(x).ackAt - (x.decidedAt ?? sel(x).sentAt)));
  const legs = a.flatMap((x) => [x.kalshi, x.poly]).filter((l) => l.qty > EPS && l.vwap !== null && l.seenAsk !== null);
  const pnl = a.reduce((s, x) => s + (x.pnlUsd ?? x.expPnlUsd ?? 0), 0);
  return {
    strategy: id, attempts: n,
    kalshiFillRate: rate(a.filter((x) => x.kalshi.status === "FILLED").length, n),
    polyFillRate: rate(a.filter((x) => x.poly.status === "FILLED").length, n),
    bothRate: rate(a.filter((x) => x.outcome === "BOTH").length, n),
    oneLegRate: rate(a.filter((x) => x.outcome === "ONE").length, n),
    noneRate: rate(a.filter((x) => x.outcome === "NONE").length, n),
    kalshiFillMs: fillMs((x) => x.kalshi), polyFillMs: fillMs((x) => x.poly),
    bothMs: dist(a.filter((x) => x.timeToBothMs !== null).map((x) => x.timeToBothMs!)),
    expPnlPerAttemptUsd: n ? Math.round((pnl / n) * 10000) / 10000 : 0,
    avgSlippageCents: legs.length ? round2(legs.reduce((s, l) => s + (l.vwap! - l.seenAsk!), 0) / legs.length) : 0,
  };
}
export const allStrategyStats = (attempts: AttemptResult[]): StrategyStats[] => STRATEGIES.map((s) => strategyStats(attempts, s));

/** Realised PnL (USD) of an attempt once the real venue results are known: hedged pairs + held legs settle, unwound legs book their unwind PnL. */
export function settledPnlUsd(a: AttemptResult, kalshiWon: boolean, polyWon: boolean): number {
  const hedged = a.hedgedQty;
  const unwound = a.unwound;
  const kQty = unwound ? hedged : a.kalshi.qty, pQty = unwound ? hedged : a.poly.qty;
  const payout = (kalshiWon ? kQty : 0) + (polyWon ? pQty : 0); // $1 per winning contract
  const cost = (kQty * (a.kalshi.vwap ?? 0) + pQty * (a.poly.vwap ?? 0) + a.kalshi.fee + a.poly.fee) / 100;
  return Math.round((payout - cost + (unwound ? (a.unwindPnlCents ?? 0) / 100 : 0)) * 100) / 100;
}
