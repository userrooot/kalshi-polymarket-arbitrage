import type { FeedStat } from "../types.ts";

const WINDOW_MS = 10_000;
export interface Meter { name: string; connected: boolean; reconnects: number; hit(): void; change(): void; latency(ms: number): void; stat(now?: number): FeedStat }
const meters = new Map<string, Meter>();

/** Per-feed message meter (msgs/s over a 10s sliding window). */
export function meter(name: string): Meter {
  const ex = meters.get(name);
  if (ex) return ex;
  let ts: number[] = [], ch: number[] = [];
  let lat: number | null = null;
  let last: number | null = null, first: number | null = null;
  const m: Meter = {
    name, connected: false, reconnects: 0,
    hit() { const n = Date.now(); last = n; ts.push(n); if (ts.length > 5000) ts = ts.slice(-2500); },
    /** The cached top/price actually CHANGED (counts toward updatesPerSec). */
    change() { ch.push(Date.now()); if (ch.length > 5000) ch = ch.slice(-2500); },
    /** One-way message latency sample (now - venue timestamp), clamped >= 0; EWMA. Clock skew caveat applies. */
    latency(ms) { if (!Number.isFinite(ms)) return; const v = Math.max(0, ms); lat = lat === null ? v : lat * 0.8 + v * 0.2; },
    stat(now = Date.now()) {
      ts = ts.filter((t) => now - t <= WINDOW_MS);
      ch = ch.filter((t) => now - t <= WINDOW_MS);
      first ??= last;
      const span = Math.min(WINDOW_MS, Math.max(1000, first === null ? WINDOW_MS : now - first));
      return { name, connected: m.connected, msgsPerSec: Math.round((ts.length / (span / 1000)) * 10) / 10, updatesPerSec: Math.round((ch.length / (span / 1000)) * 10) / 10, latencyMs: lat === null ? null : Math.round(lat), lastMsgAgeMs: last === null ? null : now - last, reconnects: m.reconnects };
    },
  };
  meters.set(name, m);
  return m;
}

export const feedStats = (): FeedStat[] => [...meters.values()].map((m) => m.stat());

/** Ticks/broadcasts per second over a 10s window. */
export function rate() {
  let ts: number[] = [];
  return {
    hit() { ts.push(Date.now()); },
    perSec() { const n = Date.now(); ts = ts.filter((t) => n - t <= WINDOW_MS); return Math.round((ts.length / (WINDOW_MS / 1000)) * 10) / 10; },
  };
}
