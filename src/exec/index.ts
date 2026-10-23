// LIVE integration of the realistic-execution simulation. The bot's simulator keeps real-settlement PnL as the headline;
// this module records depth (via hub.ts), tracks opportunity episodes, and for every simulated trade / episode start runs ALL FOUR
// strategies on the same decision with the same latency samples (evaluated ~1-2s later so the book after arrival exists).
import { config } from "../config.ts";
import { saveAttemptRow, saveLatencySample, updateTrade } from "../db.ts";
import type { Combo, ExecTradeSummary, Trade, VenueSnapshot } from "../types.ts";
import { depthQuality, history, onEpisodeStart, tracker } from "./hub.ts";
import { fixedProfile, loadProfile, mulberry32, medianOf, sampleAttempt, type AttemptSamples } from "./latency.ts";
import { allStrategyStats, runAll, runAttempt, settledPnlUsd, type Decision } from "./strategies.ts";
import { recorderStats } from "./recorderHook.ts";
import type { AttemptResult, ExecState, FillLatencyCurvePoint, LatencyProfile, StrategyId } from "./types.ts";

export const LIMITATIONS = [
  "Queue priority, hidden racers and our own order's market impact are unknowable: the race haircut (RACE_WINDOW_MS, P_LOSE_RACE) is a guess, report a range.",
  "Venue timestamps have different semantics and clock skew of a few ms swamps Polymarket's ~5 ms latency: trust measured round trips over one-way estimates.",
  "Latencies are defaults until `bun run probe` measures them on the UK server; the matching engines' own queueing is not modelled.",
  "Without Kalshi websocket depth (no API key) Kalshi depth is a coarse REST top-1 poll: Kalshi episode lifetimes are biased long and deeper levels are invisible.",
  "Long-lived 'opportunities' are disproportionately stale/false ones (strike or resolution-source mismatch), not free money.",
  "Kalshi demo is not production; Polymarket/Kalshi fee and matching-delay rules change without notice (FEES_ON formulas are UNVERIFIED).",
  "Simulation results are estimates, not guarantees.",
];

interface Group {
  id: number; decision: Decision; samples: AttemptSamples; dueAt: number;
  trade: Trade | null; results: AttemptResult[] | null;
}
const MAX_GROUPS = 400;
let profile: LatencyProfile = loadProfile();
let rng = mulberry32((config.execSeed ?? (Date.now() & 0x7fffffff)) >>> 0);
const groups: Group[] = [];
let nextGroup = 1;
let attempts: AttemptResult[] = [];            // all evaluated attempts, oldest first (bounded)
let recent: AttemptResult[] = [];              // newest first
let curve: FillLatencyCurvePoint[] = [];
let started = false;
const tradeGroup = new Map<number, Group>();

export const currentProfile = () => profile;
export function reloadProfile(p?: LatencyProfile) {
  profile = p ?? loadProfile();
  history.setFeedDelay("kalshi", medianOf(profile.kalshi.feedDelay));
  history.setFeedDelay("polymarket", medianOf(profile.polymarket.feedDelay));
}

/** How long after a decision all sequential steps, retries and the unwind have certainly happened. */
function horizonMs(): number {
  const rt = (v: LatencyProfile["kalshi"]) => medianOf(v.sendOneWay) + medianOf(v.process) + medianOf(v.ackOneWay);
  return Math.max(1500, 4 * (rt(profile.kalshi) + rt(profile.polymarket)) + config.unwindAfterMs + 400);
}

function enqueue(decision: Decision, trade: Trade | null): Group {
  const g: Group = { id: nextGroup++, decision, samples: sampleAttempt(profile, rng), dueAt: decision.decidedAt + horizonMs(), trade, results: null };
  groups.push(g);
  if (groups.length > MAX_GROUPS) { const old = groups.shift()!; if (old.trade) tradeGroup.delete(old.trade.id); }
  return g;
}

function onStart(s: import("./episodes.ts").StartInfo) {
  if (!config.execSim || groups.length > MAX_GROUPS * 2) return;
  const t = s.episode.startRecv;
  enqueue({ combo: s.episode.combo, qty: s.qty, decidedAt: t, kalshi: s.kalshi, poly: s.poly, source: "episode" }, null);
}

/** Called by the simulator right after it takes a trade. Attaches it to a recent episode decision of the same combo, else creates its own. */
export function execOnTrade(t: Trade, combo: Combo, k: VenueSnapshot, p: VenueSnapshot, now: number): void {
  if (!config.execSim || combo.kalshiAsk === null || combo.polyAsk === null) return;
  const kl = history.latest("kalshi", k.marketId), pl = history.latest("polymarket", p.marketId);
  const seen = kl && pl ? Math.max(kl.recvTs, pl.recvTs) : now;
  const decidedAt = Math.min(now, Math.max(now - 5000, seen));
  const g0 = groups.find((g) => !g.trade && g.decision.combo === combo.id && g.decision.kalshi.key === k.marketId && Math.abs(g.decision.decidedAt - decidedAt) <= 2000);
  const g = g0 ?? enqueue({ combo: combo.id, qty: t.contracts, decidedAt, kalshi: { key: k.marketId, side: combo.kalshiSide, seenAsk: combo.kalshiAsk }, poly: { key: p.marketId, side: combo.polySide, seenAsk: combo.polyAsk }, source: "trade", tradeId: t.id }, null);
  g.trade = t; g.decision.tradeId = t.id; tradeGroup.set(t.id, g);
  if (g.results) applyToTrade(g);
}

const pick = (rs: AttemptResult[], s: StrategyId) => rs.find((r) => r.strategy === s)!;

function summary(g: Group): ExecTradeSummary {
  return {
    decidedAt: g.decision.decidedAt,
    attempts: g.results!.map((a) => ({ strategy: a.strategy, outcome: a.outcome, hedgedQty: a.hedgedQty, kalshiStatus: a.kalshi.status, polyStatus: a.poly.status, timeToBothMs: a.timeToBothMs, expPnlUsd: a.expPnlUsd ?? 0, unwound: a.unwound })),
  };
}
const c2 = (n: number | null) => (n === null ? "n/a" : (Math.round(n * 100) / 100).toString());

/** Attach the exec summary to the trade; when EXEC_PRIMARY != NAIVE, the primary strategy's fills become the trade's headline economics. */
function applyToTrade(g: Group) {
  const t = g.trade;
  if (!t || t.exec || t.status !== "OPEN") return;
  t.exec = summary(g);
  const prim = config.execPrimary;
  if (prim !== "NAIVE") {
    const a = pick(g.results!, prim);
    t.execStrategy = prim;
    const keep = a.unwound ? a.hedgedQty : null;
    const kQty = keep ?? a.kalshi.qty, pQty = keep ?? a.poly.qty;
    const kP = a.kalshi.vwap ?? t.kalshiPrice, pP = a.poly.vwap ?? t.polyPrice;
    const note = ` | EXEC ${prim}: ${a.outcome} (Kalshi ${a.kalshi.status} ${c2(a.kalshi.qty)}@${c2(a.kalshi.vwap)}${a.kalshi.missReason ? " " + a.kalshi.missReason : ""}, Polymarket ${a.poly.status} ${c2(a.poly.qty)}@${c2(a.poly.vwap)}${a.poly.missReason ? " " + a.poly.missReason : ""}${a.retried ? ", hedge retried" : ""}${a.unwound ? `, unhedged leg unwound ${c2(a.unwindPnlCents)}c` : ""})`;
    t.entryReason += note;
    Object.assign(t, { kalshiQty: kQty, polyQty: pQty, kalshiPrice: kP, polyPrice: pP, feesUsd: (a.kalshi.fee + a.poly.fee) / 100, realizedUsd: a.unwound ? (a.unwindPnlCents ?? 0) / 100 : 0 });
    t.totalCost = Math.round((kP + pP) * 100) / 100;
    t.contracts = Math.max(kQty, pQty);
    t.stakeUsd = Math.round(kQty * kP + pQty * pP + a.kalshi.fee + a.poly.fee) / 100;
    if (a.outcome === "NONE") {
      Object.assign(t, { status: "SETTLED", settledAt: Date.now(), payoutUsd: 0, pnlUsd: 0, contracts: 0, stakeUsd: 0 });
      t.outcomeReason = `NOT FILLED (EXEC ${prim}): neither leg filled in the execution simulation, so no position was taken. Kalshi: ${a.kalshi.missReason ?? a.kalshi.status}; Polymarket: ${a.poly.missReason ?? a.poly.status}.`;
    }
  }
  try { updateTrade(t); } catch {}
}

function evaluate(g: Group) {
  g.results = runAll(g.decision, history, profile, { samples: g.samples });
  for (const r of g.results) {
    attempts.push(r); recent.unshift(r);
    try { saveAttemptRow(g.decision.tradeId ?? null, r.strategy, r.outcome, g.decision.decidedAt, r); } catch {}
  }
  try { saveLatencySample(g.decision.decidedAt, g.samples); } catch {}
  if (attempts.length > 8000) attempts = attempts.slice(-6000);
  if (recent.length > 50) recent.length = 50;
  cache = null;
  if (g.trade) applyToTrade(g);
}

/** The simulator calls this when a trade settles so attempts of the same decision get realised PnL. */
export function execOnSettle(t: Trade, kalshiWon: boolean, polyWon: boolean) {
  const g = tradeGroup.get(t.id);
  if (!g?.results) return;
  for (const a of g.results) a.pnlUsd = settledPnlUsd(a, kalshiWon, polyWon);
  cache = null;
}

function sweepCurve() {
  const sample = groups.filter((g) => g.results).slice(-60);
  if (!sample.length) return;
  const polyRtt = medianOf(profile.polymarket.sendOneWay) + medianOf(profile.polymarket.ackOneWay);
  const feedK = medianOf(profile.kalshi.feedDelay), feedP = medianOf(profile.polymarket.feedDelay);
  curve = [5, 10, 20, 50, 80, 100, 150, 200, 300].map((L) => {
    const fp = fixedProfile(L, polyRtt, feedK, feedP, medianOf(profile.kalshi.process));
    let both = 0, kf = 0;
    sample.forEach((g, i) => {
      const a = runAttempt("PAR", g.decision, history, fp, { rng: mulberry32(1000 + i) });
      if (a.outcome === "BOTH") both++;
      if (a.kalshi.status === "FILLED") kf++;
    });
    return { latencyMs: L, bothRate: Math.round((both / sample.length) * 1000) / 1000, kalshiFillRate: Math.round((kf / sample.length) * 1000) / 1000 };
  });
  cache = null;
}

export function startExec() {
  if (started || !config.execSim) return;
  started = true;
  reloadProfile();
  onEpisodeStart(onStart);
  console.log(`[exec] realistic execution sim ON (latency profile: ${profile.source}${profile.source === "default" ? " - run `bun run probe` on the UK server" : ""}; primary headline strategy: ${config.execPrimary})`);
  setInterval(() => {
    const now = Date.now();
    for (const g of groups) if (!g.results && now >= g.dueAt) { try { evaluate(g); } catch (e) { console.error("[exec] evaluate", e); g.results = []; } }
  }, 100).unref?.();
  setInterval(() => { tracker.sweep(Date.now()); history.gc(Date.now()); }, 1000).unref?.();
  setInterval(() => { try { sweepCurve(); } catch (e) { console.error("[exec] curve", e); } }, 30_000).unref?.();
}

let cache: { at: number; s: ExecState } | null = null;
export function execState(now = Date.now()): ExecState | null {
  if (!config.execSim) return null;
  if (cache && now - cache.at < 1000) return cache.s;
  const q = depthQuality(now);
  const s: ExecState = {
    enabled: true, profileSource: profile.source, depthQuality: q, recorder: recorderStats(),
    episodes: tracker.summary(), strategies: attempts.length ? allStrategyStats(attempts) : [], fillLatencyCurve: curve,
    recentAttempts: recent,
    limitations: q.kalshi === "rest-coarse" || q.kalshi === "none" ? LIMITATIONS : LIMITATIONS.filter((l) => !l.startsWith("Without Kalshi websocket")),
  };
  cache = { at: now, s };
  return s;
}
