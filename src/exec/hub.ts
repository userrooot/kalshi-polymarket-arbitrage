// Process-wide wiring for the LIVE bot: feeds call publishDepth() (and the set*Meta helpers); the singletons below hold the
// depth history and the episode tracker. Everything is a no-op when EXEC_SIM=0. Tests and replay build their own instances.
import type { Venue } from "../types.ts";
import { config } from "../config.ts";
import { saveEpisodeRow } from "../db.ts";
import { BookHistory } from "./bookHistory.ts";
import { recordRaw } from "./recorderHook.ts";
import { EpisodeTracker, type StartInfo } from "./episodes.ts";
import { defaultProfile } from "./latency.ts";
import { defaultKalshiTick, kalshiTickFn, parseKalshiRanges, polyTickFn, type TickFn } from "./ticks.ts";
import type { DepthEvent, Level, SideBook, VenueDepth } from "./types.ts";

export const DEPTH_LEVELS = 8;
export const KALSHI_MIN_SIZE = 0.01;
export const POLY_MIN_SIZE = 5;

const dp = defaultProfile();
export const history = new BookHistory({ minutes: config.bookHistoryMin, feedDelayMs: { kalshi: dp.kalshi.feedDelay.medianMs, polymarket: dp.polymarket.feedDelay.medianMs } });

let startHandler: ((s: StartInfo) => void) | null = null;
export const onEpisodeStart = (f: (s: StartInfo) => void) => { startHandler = f; };
export const tracker = new EpisodeTracker({
  persist: (e) => { try { saveEpisodeRow(e); } catch {} },
  onStart: (s) => startHandler?.(s),
});

// --------------------------------------------------------------- per-market metadata
const kalshiMeta = new Map<string, { closeMs?: number; tick: TickFn }>();
const polyMeta = new Map<string, { closeMs?: number; tick: TickFn; minSize: number; secondsDelayMs?: number }>();
export function setKalshiMeta(ticker: string, m: { closeMs?: number; priceRanges?: unknown }) {
  kalshiMeta.set(ticker, { closeMs: m.closeMs, tick: kalshiTickFn(parseKalshiRanges(m.priceRanges)) });
}
export interface PolyMetaIn { slug: string; closeMs?: number; tickSize?: number; minSize?: number; secondsDelayMs?: number }
export function setPolyMeta(m: PolyMetaIn) {
  const prev = polyMeta.get(m.slug);
  polyMeta.set(m.slug, {
    closeMs: m.closeMs ?? prev?.closeMs, tick: polyTickFn(m.tickSize && m.tickSize > 0 ? m.tickSize : 0.01),
    minSize: m.minSize && m.minSize > 0 ? m.minSize : prev?.minSize ?? POLY_MIN_SIZE, secondsDelayMs: m.secondsDelayMs ?? prev?.secondsDelayMs,
  });
}
export const polyMetaFor = (slug: string) => polyMeta.get(slug);
export const kalshiMetaFor = (tk: string) => kalshiMeta.get(tk);

// --------------------------------------------------------------- publishing
const lastQuality: Record<Venue, { q: "ws" | "rest-coarse"; at: number } | null> = { kalshi: null, polymarket: null };
export function publishDepth(ev: DepthEvent): void {
  if (!config.execSim) return;
  try {
    lastQuality[ev.venue] = { q: ev.depth.quality ?? "ws", at: ev.recvTs };
    history.push({ ...ev, coarse: ev.depth.quality === "rest-coarse" } as DepthEvent);
    tracker.onDepth(ev);
  } catch (e) { console.error("[exec] publishDepth", (e as Error).message); }
}
/** Honest depth quality as of now (a source counts only if it delivered within the last 10s). */
export function depthQuality(now = Date.now()): { kalshi: "ws" | "rest-coarse" | "none"; polymarket: "ws" | "none" } {
  const f = (v: Venue) => { const l = lastQuality[v]; return l && now - l.at <= 10_000 ? l.q : null; };
  return { kalshi: f("kalshi") ?? "none", polymarket: f("polymarket") === null ? "none" : "ws" };
}

// --------------------------------------------------------------- builders used by the feeds
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const empty: SideBook = { asks: [], bids: [] };

/** Kalshi books hold BIDS only: Up ask = 100 - NO bid, Down ask = 100 - YES bid. yesBids/noBids: descending, in their own price terms. */
export function kalshiDepthFrom(ticker: string, yesBids: Level[], noBids: Level[], quality: "ws" | "rest-coarse"): VenueDepth {
  const asks = (bids: Level[]): Level[] => bids.filter((l) => l.size > 0 && l.price > 0 && l.price < 100).map((l) => ({ price: r4(100 - l.price), size: l.size })).filter((l) => l.price > 0 && l.price < 100).slice(0, DEPTH_LEVELS);
  const top = (b: Level[]) => b.filter((l) => l.size > 0).slice(0, DEPTH_LEVELS);
  return {
    up: { asks: asks(noBids), bids: top(yesBids) }, down: { asks: asks(yesBids), bids: top(noBids) },
    tick: kalshiMeta.get(ticker)?.tick ?? defaultKalshiTick, minSize: KALSHI_MIN_SIZE, quality,
  };
}
export function publishKalshi(ticker: string, yesBids: Level[], noBids: Level[], venueTs: number | null, quality: "ws" | "rest-coarse") {
  if (quality === "rest-coarse") recordRaw("kalshiRest", JSON.stringify({ ticker, yes: yesBids.map((l) => [l.price, l.size]), no: noBids.map((l) => [l.price, l.size]) })); // RECORD_MD=1: REST polls feed replay when no Kalshi WS keys exist
  if (!config.execSim) return;
  publishDepth({ venue: "kalshi", key: ticker, venueTs, recvTs: Date.now(), depth: kalshiDepthFrom(ticker, yesBids, noBids, quality), closeMs: kalshiMeta.get(ticker)?.closeMs });
}
export function polyDepthFrom(slug: string, up: SideBook, down: SideBook): VenueDepth {
  const m = polyMeta.get(slug);
  return { up, down, tick: m?.tick ?? polyTickFn(0.01), minSize: m?.minSize ?? POLY_MIN_SIZE, quality: "ws", secondsDelayMs: m?.secondsDelayMs };
}
export function publishPoly(slug: string, up: SideBook, down: SideBook, venueTs: number | null) {
  if (!config.execSim) return;
  publishDepth({ venue: "polymarket", key: slug, venueTs, recvTs: Date.now(), depth: polyDepthFrom(slug, up, down), closeMs: polyMeta.get(slug)?.closeMs });
}
export { empty as emptySide };
