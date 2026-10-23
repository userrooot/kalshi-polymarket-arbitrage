// Opportunity-episode tracker. An episode is a maximal period during which buying N contracts on BOTH legs of a combo, walking
// the depth, costs strictly less than MAX_TOTAL_COST (and both books hold enough size). It ends when the depth no longer
// supports that; killedBy says which venue's update ended it (or "both" if the other venue's update inside 1ms would also
// have killed it). Episodes cut short by a feed gap (> staleMs without an event) or a window rollover are CENSORED
// (true lifetime unknown: only a lower bound).
import type { Venue } from "../types.ts";
import { config } from "../config.ts";
import { dist } from "./dist.ts";
import type { Dist, DepthEvent, Episode, Level, SurvivalPoint, VenueDepth } from "./types.ts";

export const SURVIVAL_MS = [5, 10, 20, 50, 80, 100, 150, 200, 300, 500];
const EPS = 1e-9;
type Combo = Episode["combo"];
const COMBOS: { id: Combo; k: "up" | "down"; p: "up" | "down" }[] = [
  { id: "K_UP+P_DOWN", k: "up", p: "down" },
  { id: "K_DOWN+P_UP", k: "down", p: "up" },
];

/** Cost (cents, VWAP) of buying `qty` by walking asks; null if the book is too thin. */
export function vwapCost(asks: Level[], qty: number): number | null {
  let q = 0, c = 0;
  for (const l of asks) {
    if (l.size <= 0) continue;
    const t = Math.min(l.size, qty - q);
    q += t; c += t * l.price;
    if (q >= qty - EPS) return c / qty;
  }
  return null;
}
const totalSize = (asks: Level[]) => asks.reduce((a, l) => a + (l.size > 0 ? l.size : 0), 0);

export interface Eval { ok: boolean; cost: number | null; edge: number; maxSize: number }
/** Is the combo (kalshi asks + poly asks) buyable for `n` with total VWAP cost < maxCost? Also finds the largest size that still qualifies. */
export function evalCombo(kAsks: Level[], pAsks: Level[], n: number, maxCost: number, minK = 0, minP = 0): Eval {
  const no: Eval = { ok: false, cost: null, edge: 0, maxSize: 0 };
  if (n < minK - EPS || n < minP - EPS) return no;
  const kc = vwapCost(kAsks, n), pc = vwapCost(pAsks, n);
  if (kc === null || pc === null) return no;
  const cost = kc + pc;
  if (!(cost < maxCost)) return { ...no, cost };
  let lo = n, hi = Math.min(totalSize(kAsks), totalSize(pAsks));
  const at = (q: number) => { const a = vwapCost(kAsks, q), b = vwapCost(pAsks, q); return a === null || b === null ? Infinity : a + b; };
  if (hi > lo + EPS && at(hi) < maxCost) lo = hi;
  else for (let i = 0; i < 14 && hi - lo > 1e-3; i++) { const m = (lo + hi) / 2; if (at(m) < maxCost) lo = m; else hi = m; }
  return { ok: true, cost, edge: 100 - cost, maxSize: lo };
}

interface VState { key: string; depth: VenueDepth; recvTs: number; venueTs: number | null; closeMs?: number }
interface OpenEp { ep: Episode; kBest: number | null; pBest: number | null }
interface ClosedCtx { ep: Episode; by: Venue; endRecv: number; endVenueTs: number | null; oldDepth: VenueDepth; combo: (typeof COMBOS)[number] }

export interface StartInfo { episode: Episode; kalshi: { key: string; side: "UP" | "DOWN"; seenAsk: number }; poly: { key: string; side: "UP" | "DOWN"; seenAsk: number }; qty: number }
export interface EpisodeOpts {
  n?: number; maxTotalCost?: number; staleMs?: number; maxClosed?: number;
  persist?: (e: Episode) => void;
  onStart?: (s: StartInfo) => void;
}

export class EpisodeTracker {
  private last: Partial<Record<Venue, VState>> = {};
  private open = new Map<Combo, OpenEp>();
  private closed: Episode[] = [];
  private justClosed: ClosedCtx[] = [];
  private nextId = 1;
  private killCounts: Record<string, number> = {};
  private totalClosed = 0;
  readonly n: number; readonly maxCost: number; readonly staleMs: number; private maxClosed: number;
  constructor(private o: EpisodeOpts = {}) {
    this.n = o.n ?? config.contractsPerTrade; this.maxCost = o.maxTotalCost ?? config.maxTotalCost;
    this.staleMs = o.staleMs ?? config.episodeStaleMs; this.maxClosed = o.maxClosed ?? 5000;
  }

  private finish(oe: OpenEp, endRecv: number, endVenueTs: number | null, killedBy: Episode["killedBy"], reason: Episode["killReason"], censored: boolean, ctx?: Omit<ClosedCtx, "ep" | "endRecv" | "endVenueTs" | "combo">) {
    const ep = oe.ep;
    ep.endRecv = endRecv; ep.endVenueTs = endVenueTs; ep.durationMs = Math.max(0, endRecv - ep.startRecv);
    ep.killedBy = killedBy; ep.killReason = reason; ep.censored = censored;
    this.open.delete(ep.combo);
    this.closed.push(ep); if (this.closed.length > this.maxClosed) this.closed.shift();
    this.totalClosed++;
    if (killedBy) this.killCounts[killedBy] = (this.killCounts[killedBy] ?? 0) + 1;
    if (ctx) this.justClosed.push({ ...ctx, ep, endRecv, endVenueTs, combo: COMBOS.find((c) => c.id === ep.combo)! });
    try { this.o.persist?.(ep); } catch (e) { console.error("[episodes] persist", (e as Error).message); }
  }

  private paired(): boolean {
    const k = this.last.kalshi, p = this.last.polymarket;
    if (!k || !p) return false;
    if (k.closeMs !== undefined && p.closeMs !== undefined && Math.abs(k.closeMs - p.closeMs) > 1000) return false; // venues disagree on the window
    return true;
  }

  onDepth(ev: DepthEvent): void {
    const v = ev.venue, other: Venue = v === "kalshi" ? "polymarket" : "kalshi";
    const prev = this.last[v], oth = this.last[other];
    // rollover: this venue switched market -> close everything (censored)
    if (prev && prev.key !== ev.key) for (const oe of [...this.open.values()]) this.finish(oe, ev.recvTs, ev.venueTs, "rollover", "rollover", true);
    // feed gaps: close episodes whose data is no longer live (censored)
    if (this.open.size) {
      if (prev && ev.recvTs - prev.recvTs > this.staleMs) for (const oe of [...this.open.values()]) this.finish(oe, prev.recvTs, prev.venueTs, "stale", "stale", true);
      else if (oth && ev.recvTs - oth.recvTs > this.staleMs) for (const oe of [...this.open.values()]) this.finish(oe, oth.recvTs, oth.venueTs, "stale", "stale", true);
    }
    // "both": the other venue's update within 1ms of a kill that would also have killed it
    this.justClosed = this.justClosed.filter((j) => ev.recvTs - j.endRecv <= 1 && j.ep.killedBy !== "both");
    for (const j of this.justClosed) {
      if (j.by === v || j.ep.killedBy === "both" || ev.recvTs - j.endRecv > 1) continue;
      const kd = v === "kalshi" ? ev.depth : j.oldDepth, pd = v === "kalshi" ? j.oldDepth : ev.depth;
      const e = evalCombo(kd[j.combo.k].asks, pd[j.combo.p].asks, this.n, this.maxCost, kd.minSize, pd.minSize);
      if (!e.ok) { if (j.ep.killedBy) this.killCounts[j.ep.killedBy]--; j.ep.killedBy = "both"; this.killCounts.both = (this.killCounts.both ?? 0) + 1; }
    }

    const oldDepth = prev?.depth;
    this.last[v] = { key: ev.key, depth: ev.depth, recvTs: ev.recvTs, venueTs: ev.venueTs, closeMs: ev.closeMs ?? prev?.closeMs };
    const k = this.last.kalshi, p = this.last.polymarket;
    if (!k || !p || !this.paired()) return;
    if (oth && ev.recvTs - oth.recvTs > this.staleMs) return; // do not open episodes on a stale counterpart

    for (const c of COMBOS) {
      const e = evalCombo(k.depth[c.k].asks, p.depth[c.p].asks, this.n, this.maxCost, k.depth.minSize, p.depth.minSize);
      const cur = this.open.get(c.id);
      const kBest = k.depth[c.k].asks.find((l) => l.size > 0)?.price ?? null, pBest = p.depth[c.p].asks.find((l) => l.size > 0)?.price ?? null;
      if (e.ok && !cur) {
        const ep: Episode = {
          id: this.nextId++, combo: c.id, eventKey: k.key, startVenueTs: ev.venueTs, endVenueTs: null, startRecv: ev.recvTs, endRecv: null,
          durationMs: null, maxEdgeCents: round(e.edge), maxSize: round(e.maxSize), killedBy: null, killReason: null, censored: false,
        };
        this.open.set(c.id, { ep, kBest, pBest });
        if (kBest !== null && pBest !== null)
          try { this.o.onStart?.({ episode: ep, kalshi: { key: k.key, side: c.k === "up" ? "UP" : "DOWN", seenAsk: kBest }, poly: { key: p.key, side: c.p === "up" ? "UP" : "DOWN", seenAsk: pBest }, qty: this.n }); } catch (err) { console.error("[episodes] onStart", (err as Error).message); }
      } else if (e.ok && cur) {
        cur.ep.maxEdgeCents = Math.max(cur.ep.maxEdgeCents, round(e.edge));
        cur.ep.maxSize = Math.max(cur.ep.maxSize, round(e.maxSize));
        cur.kBest = kBest; cur.pBest = pBest;
      } else if (!e.ok && cur) {
        const reason: Episode["killReason"] = (v === "kalshi" ? cur.kBest !== kBest : cur.pBest !== pBest) ? "price_moved" : "depth_consumed";
        this.finish(cur, ev.recvTs, ev.venueTs, v === "kalshi" ? "kalshi" : "poly", reason, false, { by: v, oldDepth: oldDepth ?? ev.depth });
      }
    }
  }

  /** Call periodically (e.g. each second) with the current local time: closes episodes whose feeds went silent. */
  sweep(nowRecv: number) {
    if (!this.open.size) return;
    for (const v of ["kalshi", "polymarket"] as const) {
      const s = this.last[v];
      if (s && nowRecv - s.recvTs > this.staleMs) { for (const oe of [...this.open.values()]) this.finish(oe, s.recvTs, s.venueTs, "stale", "stale", true); return; }
    }
  }
  /** Close all open episodes as censored (end of replay / shutdown). */
  closeAll(nowRecv: number, why: "rollover" | "stale" = "stale") {
    for (const oe of [...this.open.values()]) this.finish(oe, nowRecv, null, why, why, true);
  }

  openEpisodes(): Episode[] { return [...this.open.values()].map((o) => o.ep); }
  closedEpisodes(): Episode[] { return this.closed; }
  total(): number { return this.totalClosed + this.open.size; }

  /** Share of episodes lasting longer than L ms. Censored episodes count as survivors of L if they were observed at least L ms, and are dropped from the denominator otherwise. */
  survival(ls = SURVIVAL_MS): SurvivalPoint[] {
    return ls.map((ms) => {
      let den = 0, num = 0;
      for (const e of this.closed) {
        const d = e.durationMs ?? 0;
        if (e.censored && d < ms) continue;
        den++; if (d > ms) num++;
      }
      return { ms, share: den ? Math.round((num / den) * 1000) / 1000 : 0 };
    });
  }
  durationDist(): Dist { return dist(this.closed.filter((e) => !e.censored).map((e) => e.durationMs!)); }
  summary(recent = 20) {
    return {
      total: this.total(), open: this.open.size, durationMs: this.durationDist(), survival: this.survival(),
      killedBy: { ...this.killCounts },
      recent: [...this.closed.slice(-recent), ...this.openEpisodes()].sort((a, b) => b.startRecv - a.startRecv).slice(0, recent),
    };
  }
}
const round = (n: number) => Math.round(n * 100) / 100;
