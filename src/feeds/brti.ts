// Kalshi resolves on CF Benchmarks BRTI (mean of RTI over [T-60s, T-1s]). BRTI has no free live feed, so this is a
// PROXY: median of top-of-book mids from several constituent exchanges (public, no-auth websockets).
// It is NOT the licensed BRTI value and is labelled "brti-proxy" everywhere.
import { connectWS } from "./ws.ts";
import { Series, type SpotQuote } from "./spot.ts";
import { bump } from "./notify.ts";
import { meter } from "./meter.ts";

const FRESH_MS = 5000, MIN_VENUES = 3;
const mids = new Map<string, { mid: number; ts: number }>();
const series = new Series(2 * 3600_000);
let lastPub = 0, lastBump = 0;

function setMid(ex: string, bid: number, ask: number) {
  if (!(bid > 0 && ask > 0) || ask < bid) return;
  const mid = (bid + ask) / 2;
  if (mids.get(ex)?.mid !== mid) meter(`brti:${ex}`).change();
  mids.set(ex, { mid, ts: Date.now() });
  publish();
}
function median(a: number[]) { a.sort((x, y) => x - y); const n = a.length; return n % 2 ? a[n >> 1]! : (a[n / 2 - 1]! + a[n / 2]!) / 2; }
function current(now = Date.now()): number | null {
  const v = [...mids.values()].filter((x) => now - x.ts <= FRESH_MS).map((x) => x.mid);
  return v.length >= MIN_VENUES ? median(v) : null;
}
function publish() {
  const now = Date.now();
  const p = current(now);
  if (p === null) return;
  lastPub = now;
  const prev = series.last();
  if (!prev || now - prev[0] >= 1000) series.push(now, p); // 1 sample/s => time-weighted means
  if (now - lastBump >= 100) { lastBump = now; bump("spot"); }
}
const best = (rows: any[], pick: "max" | "min") => {
  const px = (rows ?? []).map((r) => Number(Array.isArray(r) ? r[0] : r?.price)).filter((x) => x > 0);
  return px.length ? Math[pick](...px) : 0;
};

export function startBrti() {
  connectWS({ name: "brti:coinbase", url: "wss://ws-feed.exchange.coinbase.com", staleMs: 15000,
    onOpen: (w) => w.send({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }),
    onMessage: (r) => { const j = JSON.parse(r); if (j.type === "ticker") setMid("coinbase", Number(j.best_bid), Number(j.best_ask)); } });
  connectWS({ name: "brti:kraken", url: "wss://ws.kraken.com/v2", staleMs: 15000,
    onOpen: (w) => w.send({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], event_trigger: "bbo" } }),
    onMessage: (r) => { const j = JSON.parse(r); if (j.channel === "ticker") for (const d of j.data ?? []) setMid("kraken", d.bid, d.ask); } });
  connectWS({ name: "brti:bitstamp", url: "wss://ws.bitstamp.net", staleMs: 15000,
    onOpen: (w) => w.send({ event: "bts:subscribe", data: { channel: "order_book_btcusd" } }),
    onMessage: (r, w) => { const j = JSON.parse(r); if (j.event === "bts:request_reconnect") w.reconnect(); else if (j.data?.bids) setMid("bitstamp", best(j.data.bids, "max"), best(j.data.asks, "min")); } });
  { // Gemini top_of_book: incremental "change" events per side; remaining 0 => level gone
    let bid = 0, ask = 0;
    connectWS({ name: "brti:gemini", url: "wss://api.gemini.com/v1/marketdata/BTCUSD?top_of_book=true&trades=false", staleMs: 30000,
      onOpen: () => { bid = 0; ask = 0; },
      onMessage: (r) => {
        const j = JSON.parse(r);
        if (j.type !== "update") return;
        for (const e of j.events ?? []) if (e.type === "change") {
          const p = Number(e.price), rem = Number(e.remaining);
          if (e.side === "bid") bid = rem > 0 ? p : bid === p ? 0 : bid; else ask = rem > 0 ? p : ask === p ? 0 : ask;
        }
        setMid("gemini", bid, ask);
      } });
  }
  { let cdcOpen: ReturnType<typeof setTimeout> | null = null;
    connectWS({ name: "brti:cryptocom", url: "wss://stream.crypto.com/exchange/v1/market", staleMs: 20000,
      onOpen: (w) => { if (cdcOpen) clearTimeout(cdcOpen); cdcOpen = setTimeout(() => w.send({ id: 1, method: "subscribe", params: { channels: ["ticker.BTC_USD"] } }), 1000); },
      onMessage: (r, w) => {
        const j = JSON.parse(r);
        if (j.method === "public/heartbeat") return w.send({ id: j.id, method: "public/respond-heartbeat" });
        for (const d of j.result?.data ?? []) if (j.result?.channel === "ticker") setMid("cryptocom", Number(d.b), Number(d.k));
      } }); }
  connectWS({ name: "brti:lmax", url: "wss://public-data-api.london-digital.lmax.com/v1/web-socket", staleMs: 20000,
    onOpen: (w) => w.send({ type: "SUBSCRIBE", channels: [{ name: "ORDER_BOOK", instruments: ["btc-usd"] }] }),
    onMessage: (r) => { const j = JSON.parse(r); if (j.type === "ORDER_BOOK" && j.status !== "CLOSED") setMid("lmax", best(j.bids, "max"), best(j.asks, "min")); } });
}

/** Median of >=3 fresh exchange mids (Kalshi/BRTI proxy). */
export function brtiSpot(): SpotQuote | null {
  const p = current();
  return p === null ? null : { price: p, ts: lastPub, source: "brti-proxy" };
}
/** Proxy mean over the last 60s, or over [closeMs-60s, closeMs-1s] for a settled window. */
export function brtiAvg60(closeMs?: number): number | null {
  if (closeMs) return series.mean(closeMs - 60_000, closeMs - 1000);
  const l = series.last();
  return l ? series.mean(l[0] - 60_000, Infinity) : null;
}
export const brtiVenues = () => [...mids].filter(([, v]) => Date.now() - v.ts <= FRESH_MS).map(([k]) => k);
