import type { FeedStat } from "../types.ts";

const WINDOW_MS = 10_000;
export interface Meter { name: string; connected: boolean; reconnects: number; hit(): void; stat(now?: number): FeedStat }
const meters = new Map<string, Meter>();

/** Per-feed message meter (msgs/s over a 10s sliding window). */
export function meter(name: string): Meter {
  const ex = meters.get(name);
  if (ex) return ex;
  let ts: number[] = [];
  let last: number | null = null, first: number | null = null;
  const m: Meter = {
    name, connected: false, reconnects: 0,
    hit() { const n = Date.now(); last = n; ts.push(n); if (ts.length > 5000) ts = ts.slice(-2500); },
    stat(now = Date.now()) {
      ts = ts.filter((t) => now - t <= WINDOW_MS);
      first ??= last;
      const span = Math.min(WINDOW_MS, Math.max(1000, first === null ? WINDOW_MS : now - first));
      return { name, connected: m.connected, msgsPerSec: Math.round((ts.length / (span / 1000)) * 10) / 10, lastMsgAgeMs: last === null ? null : now - last, reconnects: m.reconnects };
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
