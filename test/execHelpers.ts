// Synthetic-book helpers for the exec tests.
import { BookHistory } from "../src/exec/bookHistory.ts";
import { defaultKalshiTick, polyTickFn } from "../src/exec/ticks.ts";
import type { DepthEvent, Level, SideBook, VenueDepth } from "../src/exec/types.ts";
import type { Venue } from "../src/types.ts";

type L = [number, number][];
const lv = (a: L): Level[] => a.map(([price, size]) => ({ price, size }));
export interface DepthSpec { upAsks?: L; upBids?: L; downAsks?: L; downBids?: L; minSize?: number; secondsDelayMs?: number }
export function depth(venue: Venue, s: DepthSpec): VenueDepth {
  const side = (asks?: L, bids?: L): SideBook => ({ asks: lv(asks ?? []), bids: lv(bids ?? []) });
  return {
    up: side(s.upAsks, s.upBids), down: side(s.downAsks, s.downBids),
    tick: venue === "kalshi" ? defaultKalshiTick : polyTickFn(0.01),
    minSize: s.minSize ?? (venue === "kalshi" ? 0.01 : 5), secondsDelayMs: s.secondsDelayMs,
  };
}
export const ev = (venue: Venue, key: string, recvTs: number, s: DepthSpec, venueTs: number | null = null): DepthEvent =>
  ({ venue, key, recvTs, venueTs, depth: depth(venue, s) });

export const K = "KXBTC15M-T", P = "btc-updown-15m-1";
/** History with zero feed delay so venue time == recv time in tests. */
export const newHistory = () => new BookHistory({ feedDelayMs: { kalshi: 0, polymarket: 0 } });
/** Kalshi Up ask a / Down ask b ; Polymarket Up ask c / Down ask d, all deep (size 1000) with bids 1c below. */
export function flat(h: BookHistory, t: number, k: { up: number; down: number }, p: { up: number; down: number }, size = 1000) {
  h.push(ev("kalshi", K, t, { upAsks: [[k.up, size]], upBids: [[k.up - 1, size]], downAsks: [[k.down, size]], downBids: [[k.down - 1, size]] }));
  h.push(ev("polymarket", P, t, { upAsks: [[p.up, size]], upBids: [[p.up - 1, size]], downAsks: [[p.down, size]], downBids: [[p.down - 1, size]] }));
}
