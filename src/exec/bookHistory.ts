// Ring buffer of full depth per (venue,key). Memory-bound: only the top DEPTH_LEVELS per side are expected from publishers,
// consecutive identical depths are not stored, SideBook arrays are shared between events (treat them as IMMUTABLE), and each
// key keeps at most `maxEventsPerKey` events.
//
// Two timelines:
//  - "venue"  (default): local-clock-equivalent time at which the venue's book actually had this state =
//             venueTs + offset when venueTs is known (offset learned from the low end of recv-venueTs), else recvTs - feedDelay.
//             An order that ARRIVES at the venue at time A sees the last event with t <= A.
//  - "recv": the time we received the event (what the bot could have seen).
import type { Venue } from "../types.ts";
import type { DepthEvent, SideBook, VenueDepth } from "./types.ts";

export interface StoredEvent { t: number; venueTs: number | null; recvTs: number; depth: VenueDepth; coarse?: boolean }

/** Running clock-offset estimator for one venue: offset ~ low percentile of (recv - venueTs) minus the nominal feed delay. */
export class ClockModel {
  private diffs: number[] = [];
  private i = 0;
  constructor(public feedDelayMs: number, private cap = 256) {}
  observe(venueTs: number | null, recvTs: number) {
    if (venueTs === null || !Number.isFinite(venueTs)) return;
    const d = recvTs - venueTs;
    if (this.diffs.length < this.cap) this.diffs.push(d); else { this.diffs[this.i] = d; this.i = (this.i + 1) % this.cap; }
  }
  /** Low end (min) of recv-venueTs, or null with no samples. */
  get lowDiff(): number | null { return this.diffs.length ? Math.min(...this.diffs) : null; }
  /** venue-time (local clock) for an event. */
  toVenueTime(venueTs: number | null, recvTs: number): number {
    const low = this.lowDiff;
    if (venueTs === null || !Number.isFinite(venueTs) || low === null) return recvTs - this.feedDelayMs;
    return venueTs + (low - this.feedDelayMs);
  }
}
/** Map one event onto the venue timeline using a clock model (observes first). */
export function toVenueTimeline(ev: Pick<DepthEvent, "venueTs" | "recvTs">, model: ClockModel): number {
  model.observe(ev.venueTs, ev.recvTs);
  return model.toVenueTime(ev.venueTs, ev.recvTs);
}

const sameSide = (a: SideBook, b: SideBook) => a === b || (sameLv(a.asks, b.asks) && sameLv(a.bids, b.bids));
function sameLv(a: { price: number; size: number }[], b: { price: number; size: number }[]) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]!.price !== b[i]!.price || a[i]!.size !== b[i]!.size) return false;
  return true;
}
export const sameDepth = (a: VenueDepth, b: VenueDepth) => sameSide(a.up, b.up) && sameSide(a.down, b.down);

class Track {
  ev: StoredEvent[] = [];
  head = 0;
  lastRecv = 0;
  get length() { return this.ev.length - this.head; }
  push(e: StoredEvent) { this.ev.push(e); }
  last(): StoredEvent | null { return this.length ? this.ev[this.ev.length - 1]! : null; }
  dropWhile(f: (e: StoredEvent) => boolean) {
    while (this.head < this.ev.length - 1 && f(this.ev[this.head]!)) this.head++;
    if (this.head > 2048 && this.head > this.ev.length / 2) { this.ev = this.ev.slice(this.head); this.head = 0; }
  }
  /** Index (absolute) of the last event with f(e) <= x, or -1. */
  find(x: number, f: (e: StoredEvent) => number): number {
    let lo = this.head, hi = this.ev.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (f(this.ev[m]!) <= x) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
}

export interface BookHistoryOpts { minutes?: number; maxEventsPerKey?: number; feedDelayMs?: Partial<Record<Venue, number>> }

export class BookHistory {
  private tracks = new Map<string, Track>();
  private meta = new Map<string, { venue: Venue; key: string }>();
  private clocks: Record<Venue, ClockModel>;
  private windowMs: number;
  private maxEv: number;
  constructor(o: BookHistoryOpts = {}) {
    this.windowMs = (o.minutes ?? 20) * 60_000;
    this.maxEv = o.maxEventsPerKey ?? 30_000;
    this.clocks = { kalshi: new ClockModel(o.feedDelayMs?.kalshi ?? 45), polymarket: new ClockModel(o.feedDelayMs?.polymarket ?? 4) };
  }
  setFeedDelay(venue: Venue, ms: number) { this.clocks[venue].feedDelayMs = ms; }
  private id = (v: Venue, k: string) => v + "\u0000" + k;
  private track(v: Venue, k: string, create = false): Track | undefined {
    const id = this.id(v, k);
    let t = this.tracks.get(id);
    if (!t && create) { this.tracks.set(id, (t = new Track())); this.meta.set(id, { venue: v, key: k }); }
    return t;
  }

  /** Add an event. Returns the stored venue-timeline timestamp, or null if it was a duplicate of the latest depth. */
  push(ev: DepthEvent & { coarse?: boolean }): number | null {
    const tr = this.track(ev.venue, ev.key, true)!;
    const clock = this.clocks[ev.venue];
    let t = toVenueTimeline(ev, clock);
    const last = tr.last();
    tr.lastRecv = ev.recvTs;
    if (last) {
      if (sameDepth(last.depth, ev.depth)) return null;
      if (t < last.t) t = last.t; // keep the timeline monotone (jitter)
    }
    tr.push({ t, venueTs: ev.venueTs, recvTs: Math.max(ev.recvTs, last?.recvTs ?? 0), depth: ev.depth, coarse: ev.coarse });
    const cutoff = t - this.windowMs;
    tr.dropWhile((e) => e.t < cutoff || tr.length > this.maxEv);
    return t;
  }

  /** Stored event as of time t (last event with ts <= t), on the venue (default) or recv timeline. */
  atEvent(venue: Venue, key: string, t: number, clock: "venue" | "recv" = "venue"): StoredEvent | null {
    const tr = this.track(venue, key);
    if (!tr || !tr.length) return null;
    const i = tr.find(t, clock === "venue" ? (e) => e.t : (e) => e.recvTs);
    return i < 0 ? null : tr.ev[i]!;
  }
  at(venue: Venue, key: string, t: number, clock: "venue" | "recv" = "venue"): VenueDepth | null { return this.atEvent(venue, key, t, clock)?.depth ?? null; }

  /** Events with t0 < t <= t1 on the venue timeline (oldest first). */
  between(venue: Venue, key: string, t0: number, t1: number): StoredEvent[] {
    const tr = this.track(venue, key);
    if (!tr || !tr.length) return [];
    let i = tr.find(t0, (e) => e.t) + 1;
    if (i < tr.head) i = tr.head;
    const out: StoredEvent[] = [];
    for (; i < tr.ev.length && tr.ev[i]!.t <= t1; i++) out.push(tr.ev[i]!);
    return out;
  }
  latest(venue: Venue, key: string): StoredEvent | null { return this.track(venue, key)?.last() ?? null; }
  /** Last time we received ANY event (even a duplicate) for this key. */
  lastSeenRecv(venue: Venue, key: string): number | null { return this.track(venue, key)?.lastRecv ?? null; }
  keys(): { venue: Venue; key: string }[] { return [...this.meta.values()]; }
  size(venue: Venue, key: string): number { return this.track(venue, key)?.length ?? 0; }
  /** Approximate lowest/highest venue-timeline timestamps held for a key. */
  span(venue: Venue, key: string): { from: number; to: number } | null {
    const tr = this.track(venue, key);
    return tr?.length ? { from: tr.ev[tr.head]!.t, to: tr.last()!.t } : null;
  }
  /** Drop keys not seen for `olderThanMs` (window rollovers). */
  gc(nowRecv: number, olderThanMs = this.windowMs) {
    for (const [id, tr] of this.tracks) if (nowRecv - tr.lastRecv > olderThanMs) { this.tracks.delete(id); this.meta.delete(id); }
  }
}
