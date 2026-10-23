import { connectWS, type WSHandle } from "./ws.ts";
import { bump } from "./notify.ts";
import { meter } from "./meter.ts";
import { DEPTH_LEVELS, setPolyMeta, publishPoly } from "../exec/hub.ts";
import type { SideBook } from "../exec/types.ts";

export interface Top { ask: number | null; bid: number | null; ts: number; rest?: boolean }
const tops = new Map<string, Top>();
const books = new Map<string, { asks: Map<string, number>; bids: Map<string, number> }>(); // price(str)->size
let watched: string[] = [];
let slug: string | null = null; // market slug of the watched tokens (key of the exec depth history)
const sides = new Map<string, SideBook>(); // token -> top-N ladder (asks ascending, bids descending, cents)
let handle: WSHandle | null = null;
const cents = (x: unknown) => { const n = Number(x) * 100; return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };

/** Store a top; wake the tick loop only when ask/bid actually changed (the raw event rate is ~1000/s). */
function setTop(token: string, ask: number | null, bid: number | null) {
  const prev = tops.get(token);
  tops.set(token, { ask, bid, ts: Date.now() });
  if (!prev || prev.ask !== ask || prev.bid !== bid) { meter("polyBook").change(); bump("poly"); }
}
function fromBook(token: string) {
  const b = books.get(token);
  if (!b) return;
  const a = [...b.asks].filter(([, s]) => s > 0).map(([p]) => Number(p) * 100);
  const d = [...b.bids].filter(([, s]) => s > 0).map(([p]) => Number(p) * 100);
  setTop(token, a.length ? Math.round(Math.min(...a) * 100) / 100 : null, d.length ? Math.round(Math.max(...d) * 100) / 100 : null);
}
const r4 = (n: number) => Math.round(n * 1e6) / 1e6;
/** Publish the full (top-N) ladders of both tokens to the exec layer. Needs both books; size 0 levels are ignored. */
function publishDepthFor(token: string, venueTs: number | null) {
  const b = books.get(token);
  if (!b || !slug) return;
  const lv = (m: Map<string, number>, desc: boolean) =>
    [...m].filter(([, s]) => s > 0).map(([p, s]) => ({ price: r4(Number(p) * 100), size: s })).filter((l) => l.price > 0 && l.price < 100 + 1e-9)
      .sort((x, y) => (desc ? y.price - x.price : x.price - y.price)).slice(0, DEPTH_LEVELS);
  sides.set(token, { asks: lv(b.asks, false).filter((l) => l.price < 100), bids: lv(b.bids, true) });
  const up = sides.get(watched[0]!), down = sides.get(watched[1]!);
  if (up && down) publishPoly(slug, up, down, venueTs);
}
function handleEvent(e: any) {
  const t = e?.event_type;
  const ets = Number(e?.timestamp); // venue ms timestamp (clock-skew caveat)
  const vts = ets > 1e12 ? ets : null;
  if (ets > 1e12) meter("polyBook").latency(Date.now() - ets);
  if (t === "book" && watched.includes(e.asset_id)) {
    const side = (rows: any[]) => new Map<string, number>((rows ?? []).map((r) => [String(r.price), Number(r.size)]));
    books.set(e.asset_id, { asks: side(e.asks), bids: side(e.bids) });
    if (slug && Number(e.tick_size) > 0) setPolyMeta({ slug, tickSize: Number(e.tick_size) });
    fromBook(e.asset_id);
    publishDepthFor(e.asset_id, vts);
  } else if (t === "tick_size_change") {
    if (slug && Number(e.new_tick_size) > 0) setPolyMeta({ slug, tickSize: Number(e.new_tick_size) });
  } else if (t === "price_change") {
    const touched = new Set<string>();
    for (const c of e.price_changes ?? []) {
      if (!watched.includes(c.asset_id)) continue;
      const b = books.get(c.asset_id);
      if (b && c.price !== undefined) { // keep full book in sync when we have it
        const m = c.side === "SELL" ? b.asks : b.bids;
        Number(c.size) > 0 ? m.set(String(c.price), Number(c.size)) : m.delete(String(c.price));
        touched.add(c.asset_id);
      }
      const ask = cents(c.best_ask), bid = cents(c.best_bid);
      if (c.best_ask !== undefined || c.best_bid !== undefined) {
        setTop(c.asset_id, ask !== null && ask < 100 ? ask : null, bid); // ask 1.00 = empty side
      } else fromBook(c.asset_id);
    }
    for (const tk of touched) publishDepthFor(tk, vts);
  } else if (t === "best_bid_ask" && watched.includes(e.asset_id)) {
    const ask = cents(e.best_ask), bid = cents(e.best_bid);
    setTop(e.asset_id, ask !== null && ask < 100 ? ask : null, bid);
  }
}
function subscribeAll(ws: WSHandle) {
  if (watched.length) ws.send({ assets_ids: watched, type: "market", custom_feature_enabled: true });
}

export function startPolyBook() {
  handle = connectWS({
    name: "polyBook", url: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    pingMs: 10_000, pingMsg: "PING", staleMs: 60_000,
    onOpen: (ws) => { books.clear(); sides.clear(); subscribeAll(ws); },
    onMessage: (raw) => {
      if (raw[0] !== "{" && raw[0] !== "[") return;
      const j = JSON.parse(raw);
      for (const e of Array.isArray(j) ? j : [j]) handleEvent(e);
    },
  });
}
/** Watch the tokens of the current window. On rollover we subscribe the new ones (old events are filtered by asset_id). */
export function watchTokens(up: string, down: string, marketSlug?: string) {
  if (marketSlug) slug = marketSlug;
  if (watched[0] === up && watched[1] === down) return;
  const prev = watched;
  watched = [up, down];
  for (const t of prev) { tops.delete(t); books.delete(t); sides.delete(t); }
  if (prev.length) handle?.send({ assets_ids: watched, operation: "subscribe" });
  else if (handle) subscribeAll(handle);
}
/** REST-fallback write (marked rest=true until a WS event replaces it). */
export const setPolyTop = (token: string, ask: number | null, bid: number | null) => { tops.set(token, { ask, bid, ts: Date.now(), rest: true }); };
export const polyTop = (token: string): Top | null => tops.get(token) ?? null;
