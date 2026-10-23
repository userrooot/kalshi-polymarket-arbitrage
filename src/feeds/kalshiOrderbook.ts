// Pure Kalshi order-book builder (snapshot + deltas) and per-subscription seq tracker. No I/O.
// Kalshi books hold BIDS only. Prices arrive as dollar strings ("0.9600") and are converted to cents.
//
// Two NO-side conventions (single flag `noOnYesScale`):
//  - false: NO levels are in NO-price terms (REST orderbook; also WS with use_yes_price=false). Best NO bid = max level.
//  - true : NO levels are on the YES price scale (WS with use_yes_price=true): a NO level shown at 0.70 is a NO bid of 30c,
//           so best NO bid (NO terms) = 100 - min(shown NO level).
// Either way top() returns yesBid / noBid in their OWN price terms, exactly like the REST path in kalshiBook.ts, so callers do
// Up ask = 100 - noBid, Down ask = 100 - yesBid.

export type DeltaResult = "ok" | "no-snapshot";
export const toCents = (dollars: unknown): number => Math.round(Number(dollars) * 10000) / 100;

export class KalshiBook {
  yes = new Map<number, number>(); // shown price (cents) -> size
  no = new Map<number, number>();
  snapshotted = false;
  constructor(public noOnYesScale = true) {}

  reset() { this.yes.clear(); this.no.clear(); this.snapshotted = false; }

  /** msg: {yes_dollars_fp?: [[price, size],...], no_dollars_fp?: [...]} (either key may be absent). */
  snapshot(msg: any) {
    const load = (rows: unknown, into: Map<number, number>) => {
      into.clear();
      for (const r of Array.isArray(rows) ? rows : []) {
        const p = toCents(r?.[0]), s = Number(r?.[1]);
        if (Number.isFinite(p) && s > 0) into.set(p, s);
      }
    };
    load(msg?.yes_dollars_fp ?? msg?.yes_dollars, this.yes);
    load(msg?.no_dollars_fp ?? msg?.no_dollars, this.no);
    this.snapshotted = true;
  }

  /** msg: {price_dollars, delta_fp, side}. Size change; level removed when it reaches <= 0. */
  delta(msg: any): DeltaResult {
    if (!this.snapshotted) return "no-snapshot";
    const side = msg?.side === "no" ? this.no : msg?.side === "yes" ? this.yes : null;
    const p = toCents(msg?.price_dollars), d = Number(msg?.delta_fp);
    if (!side || !Number.isFinite(p) || !Number.isFinite(d)) return "ok";
    const n = (side.get(p) ?? 0) + d;
    if (n > 1e-9) side.set(p, n); else side.delete(p);
    return "ok";
  }

  /** Best bids in each side's own price terms (cents), null when a side is empty. */
  top(): { yesBid: number | null; noBid: number | null } {
    const ys = [...this.yes.keys()], ns = [...this.no.keys()];
    const yesBid = ys.length ? Math.max(...ys) : null;
    const nb = ns.length ? (this.noOnYesScale ? 100 - Math.min(...ns) : Math.max(...ns)) : null;
    const noBid = nb === null ? null : Math.round(nb * 100) / 100;
    return { yesBid: yesBid !== null && yesBid > 0 ? yesBid : null, noBid: noBid !== null && noBid > 0 ? noBid : null };
  }
  /** Full bid ladders, each DESCENDING and in its own price terms (NO levels converted off the YES scale when noOnYesScale). */
  levels(): { yesBids: { price: number; size: number }[]; noBids: { price: number; size: number }[] } {
    const mk = (m: Map<number, number>, conv: (p: number) => number) =>
      [...m].map(([p, size]) => ({ price: Math.round(conv(p) * 100) / 100, size })).filter((l) => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price);
    return { yesBids: mk(this.yes, (p) => p), noBids: mk(this.no, (p) => (this.noOnYesScale ? 100 - p : p)) };
  }
  /** Equivalent asks: Up(YES) ask = 100 - best NO bid; Down(NO) ask = 100 - best YES bid. */
  asks() { const t = this.top(); return { upAsk: t.noBid === null ? null : 100 - t.noBid, downAsk: t.yesBid === null ? null : 100 - t.yesBid }; }
}

/** Gap-free per-sid sequence check. Snapshots (re)base the sequence. */
export class SeqTracker {
  private last = new Map<number, number>();
  /** "first": nothing known for this sid yet (accepted, rebased). "gap": seq != last+1 (caller must resync; tracker rebases to seq). */
  check(sid: number, seq: number): "ok" | "gap" | "first" {
    const prev = this.last.get(sid);
    this.last.set(sid, seq);
    if (prev === undefined) return "first";
    return seq === prev + 1 ? "ok" : "gap";
  }
  rebase(sid: number, seq: number) { this.last.set(sid, seq); }
  clear() { this.last.clear(); }
}
