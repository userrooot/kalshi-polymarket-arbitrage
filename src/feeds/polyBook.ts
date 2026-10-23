import { connectWS, type WSHandle } from "./ws.ts";
import { bump } from "./notify.ts";
import { meter } from "./meter.ts";

export interface Top { ask: number | null; bid: number | null; ts: number; rest?: boolean }
const tops = new Map<string, Top>();
const books = new Map<string, { asks: Map<string, number>; bids: Map<string, number> }>(); // price(str)->size
let watched: string[] = [];
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
function handleEvent(e: any) {
  const t = e?.event_type;
  const ets = Number(e?.timestamp); // venue ms timestamp (clock-skew caveat)
  if (ets > 1e12) meter("polyBook").latency(Date.now() - ets);
  if (t === "book" && watched.includes(e.asset_id)) {
    const side = (rows: any[]) => new Map<string, number>((rows ?? []).map((r) => [String(r.price), Number(r.size)]));
    books.set(e.asset_id, { asks: side(e.asks), bids: side(e.bids) });
    fromBook(e.asset_id);
  } else if (t === "price_change") {
    for (const c of e.price_changes ?? []) {
      if (!watched.includes(c.asset_id)) continue;
      const b = books.get(c.asset_id);
      if (b && c.price !== undefined) { // keep full book in sync when we have it
        const m = c.side === "SELL" ? b.asks : b.bids;
        Number(c.size) > 0 ? m.set(String(c.price), Number(c.size)) : m.delete(String(c.price));
      }
      const ask = cents(c.best_ask), bid = cents(c.best_bid);
      if (c.best_ask !== undefined || c.best_bid !== undefined) {
        setTop(c.asset_id, ask !== null && ask < 100 ? ask : null, bid); // ask 1.00 = empty side
      } else fromBook(c.asset_id);
    }
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
    onOpen: (ws) => { books.clear(); subscribeAll(ws); },
    onMessage: (raw) => {
      if (raw[0] !== "{" && raw[0] !== "[") return;
      const j = JSON.parse(raw);
      for (const e of Array.isArray(j) ? j : [j]) handleEvent(e);
    },
  });
}
/** Watch the tokens of the current window. On rollover we subscribe the new ones (old events are filtered by asset_id). */
export function watchTokens(up: string, down: string) {
  if (watched[0] === up && watched[1] === down) return;
  const prev = watched;
  watched = [up, down];
  for (const t of prev) { tops.delete(t); books.delete(t); }
  if (prev.length) handle?.send({ assets_ids: watched, operation: "subscribe" });
  else if (handle) subscribeAll(handle);
}
/** REST-fallback write (marked rest=true until a WS event replaces it). */
export const setPolyTop = (token: string, ask: number | null, bid: number | null) => { tops.set(token, { ask, bid, ts: Date.now(), rest: true }); };
export const polyTop = (token: string): Top | null => tops.get(token) ?? null;
