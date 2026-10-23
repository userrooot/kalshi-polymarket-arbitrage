// Pure raw-message -> DepthEvent adapters used by replay (no I/O, no wall clock). Kalshi uses the live pure builder
// (KalshiBook + SeqTracker from feeds/kalshiOrderbook.ts); the Polymarket book mirrors feeds/polyBook.ts (book snapshot +
// price_change deltas, SELL = ask side) but keeps FULL depth.
import { KalshiBook, SeqTracker } from "../feeds/kalshiOrderbook.ts";
import type { RecordLine } from "./recorder.ts";
import { defaultKalshiTick, polyTickFn, type TickFn } from "./ticks.ts";
import type { DepthEvent, Level, SideBook, VenueDepth } from "./types.ts";

export const MAX_LEVELS = 8; // = DEPTH_LEVELS in exec/hub.ts (live parity)
export const KALSHI_MIN_SIZE = 0.01, POLY_MIN_SIZE = 5; // = exec/hub.ts
export const WINDOW_MS = 900_000;
const cents = (x: unknown) => { const n = Number(x) * 100; return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
const round2 = (n: number) => Math.round(n * 100) / 100;
const asc = (m: Map<number, number>): Level[] => [...m].filter(([, s]) => s > 0).sort((a, b) => a[0] - b[0]).slice(0, MAX_LEVELS).map(([price, size]) => ({ price, size }));
const desc = (m: Map<number, number>): Level[] => [...m].filter(([, s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, MAX_LEVELS).map(([price, size]) => ({ price, size }));
const closeOf = (recv: number) => (Math.floor(recv / WINDOW_MS) + 1) * WINDOW_MS;

/** Kalshi books hold BIDS only: Up(YES) asks = 100 - NO bids, Down(NO) asks = 100 - YES bids. */
export function kalshiDepth(b: KalshiBook, tick: TickFn = defaultKalshiTick): VenueDepth {
  const yesBids = new Map<number, number>(), noBids = new Map<number, number>();
  for (const [p, s] of b.yes) yesBids.set(p, s);
  for (const [p, s] of b.no) noBids.set(b.noOnYesScale ? round2(100 - p) : p, s);
  const inv = (m: Map<number, number>) => new Map([...m].map(([p, s]) => [round2(100 - p), s] as [number, number]));
  const up: SideBook = { asks: asc(inv(noBids)), bids: desc(yesBids) };
  const down: SideBook = { asks: asc(inv(yesBids)), bids: desc(noBids) };
  return { up, down, tick, minSize: KALSHI_MIN_SIZE, quality: "ws" };
}

export interface AdapterOpts { polyMinSize?: number; polyTick?: number; upToken?: string; downToken?: string }

/** Streaming converter: feed RecordLines in recorded order, get DepthEvents (venue-time = venueTs, local = recv). */
export class DepthAdapter {
  private kb = new Map<string, KalshiBook>();
  private seq = new SeqTracker();
  private pb = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();
  private tick = new Map<string, number>();
  private up: string | null; private down: string | null;
  private firstSeen = new Map<string, number>();
  noOnYesScale = true;
  constructor(private o: AdapterOpts = {}) { this.up = o.upToken ?? null; this.down = o.downToken ?? null; }

  private close(key: string, recv: number) {
    let f = this.firstSeen.get(key);
    if (f === undefined) { f = closeOf(recv); this.firstSeen.set(key, f); }
    return f;
  }

  push(l: RecordLine): DepthEvent[] {
    let j: any;
    if (l.src.endsWith(">")) { if (l.src.startsWith("polyBook")) this.outbound(l.raw); return []; }
    if (l.raw[0] !== "{" && l.raw[0] !== "[") return [];
    try { j = JSON.parse(l.raw); } catch { return []; }
    if (l.src === "kalshiRest") return this.kalshiRest(j, l);
    if (l.src.startsWith("kalshiBook")) return this.kalshi(j, l);
    if (l.src === "polyBook") return (Array.isArray(j) ? j : [j]).flatMap((e) => this.poly(e, l));
    return [];
  }

  private outbound(raw: string) {
    try {
      const j = JSON.parse(raw);
      if (Array.isArray(j?.assets_ids) && j.assets_ids.length >= 2) {
        const [u, d] = j.assets_ids.map(String);
        if (u !== this.up || d !== this.down) { this.up = u; this.down = d; this.pb.clear(); } // rollover: [up, down] order as in watchTokens()
      }
    } catch { /* ignore */ }
  }

  private kalshi(j: any, l: RecordLine): DepthEvent[] {
    const t = j?.type;
    if (t !== "orderbook_snapshot" && t !== "orderbook_delta") return [];
    const tk: string | undefined = j.msg?.market_ticker;
    if (!tk) return [];
    const sid = Number(j.sid), sq = Number(j.seq);
    const vt = Number(j.msg?.ts_ms) || Number(j.sending_ts_ms); // same precedence as live kalshiWs.ts tsOf()
    const venueTs = vt > 1e12 ? vt : l.venueTs ?? null;
    let b = this.kb.get(tk);
    if (t === "orderbook_snapshot") {
      this.seq.rebase(sid, sq);
      if (!b) this.kb.set(tk, (b = new KalshiBook(this.noOnYesScale)));
      b.snapshot(j.msg);
    } else {
      if (this.seq.check(sid, sq) === "gap") { for (const x of this.kb.values()) x.reset(); return []; }
      if (!b || !b.snapshotted) return [];
      b.delta(j.msg);
    }
    return [{ venue: "kalshi", key: tk, venueTs, recvTs: l.recv, depth: kalshiDepth(b), closeMs: this.close("k:" + tk, l.recv) }];
  }

  /** REST-coarse top-of-book poll recorded by exec/hub.ts: {ticker, yes:[[price,size]], no:[[price,size]]} in each side's OWN bid terms. */
  private kalshiRest(j: any, l: RecordLine): DepthEvent[] {
    const tk = j?.ticker;
    if (typeof tk !== "string") return [];
    const b = new KalshiBook(false);
    for (const [p, s] of j.yes ?? []) b.yes.set(Number(p), Number(s));
    for (const [p, s] of j.no ?? []) b.no.set(Number(p), Number(s));
    const depth = kalshiDepth(b);
    depth.quality = "rest-coarse";
    return [{ venue: "kalshi", key: tk, venueTs: null, recvTs: l.recv, depth, closeMs: this.close("k:" + tk, l.recv) }];
  }

  private book(id: string) { let b = this.pb.get(id); if (!b) this.pb.set(id, (b = { asks: new Map(), bids: new Map() })); return b; }
  private poly(e: any, l: RecordLine): DepthEvent[] {
    const t = e?.event_type;
    const touched = new Set<string>();
    const lvl = (rows: any[]) => new Map<number, number>((rows ?? []).map((r) => [cents(r.price), Number(r.size)] as [number, number]).filter(([p, s]) => Number.isFinite(p) && Number.isFinite(s)));
    if (!this.up || !this.down) { // no subscription line recorded: first two distinct asset ids seen, in order, are [up, down]
      const ids = [e?.asset_id, ...(e?.price_changes ?? []).map((c: any) => c.asset_id)].filter(Boolean).map(String);
      for (const id of ids) { if (!this.up) this.up = id; else if (!this.down && id !== this.up) this.down = id; }
    }
    const watched = (id: unknown) => id === this.up || id === this.down;
    if (t === "book" && watched(e.asset_id)) { this.pb.set(e.asset_id, { asks: lvl(e.asks), bids: lvl(e.bids) }); touched.add(e.asset_id); }
    else if (t === "price_change") {
      for (const c of e.price_changes ?? []) {
        if (!watched(c.asset_id) || c.price === undefined) continue;
        const b = this.pb.get(c.asset_id);
        if (!b) continue; // need a snapshot first
        const m = c.side === "SELL" ? b.asks : b.bids, p = cents(c.price), s = Number(c.size);
        if (!Number.isFinite(p)) continue;
        s > 0 ? m.set(p, s) : m.delete(p);
        touched.add(c.asset_id);
      }
    } else if (t === "tick_size_change" && watched(e.asset_id)) { const n = Number(e.new_tick_size); if (n > 0) this.tick.set(e.asset_id, n); }
    if (!touched.size || !this.up || !this.down) return [];
    const u = this.pb.get(this.up), d = this.pb.get(this.down);
    if (!u || !d) return [];
    const key = `poly:${this.up.slice(0, 12)}`;
    const ts = Number(e.timestamp);
    const tick = polyTickFn(this.tick.get(this.up) ?? this.o.polyTick ?? 0.01);
    const depth: VenueDepth = { up: { asks: asc(u.asks), bids: desc(u.bids) }, down: { asks: asc(d.asks), bids: desc(d.bids) }, tick, minSize: this.o.polyMinSize ?? POLY_MIN_SIZE, quality: "ws" };
    return [{ venue: "polymarket", key, venueTs: ts > 1e12 ? ts : l.venueTs ?? null, recvTs: l.recv, depth, closeMs: this.close("p:" + key, l.recv) }];
  }
}

/** Convert a whole recording (already in recorded order) to DepthEvents. */
export function toDepthEvents(lines: Iterable<RecordLine>, o: AdapterOpts = {}): DepthEvent[] {
  const a = new DepthAdapter(o);
  const out: DepthEvent[] = [];
  for (const l of lines) for (const e of a.push(l)) out.push(e);
  return out;
}
