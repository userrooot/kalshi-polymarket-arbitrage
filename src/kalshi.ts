import { config } from "./config.ts";
import { getJson, realAsk } from "./http.ts";
import { btcPrice, btcRestTs } from "./btc.ts";
import { brtiAvg60, brtiSpot } from "./feeds/brti.ts";
import { fetchKalshiTop, kalshiTop, kalshiWatch } from "./feeds/kalshiBook.ts";
import type { Side, VenueSnapshot } from "./types.ts";

let cached: any = null; // current-window market (static fields)

async function findCurrent(now: number) {
  if (cached && Date.parse(cached.open_time) <= now && now < Date.parse(cached.close_time)) return cached;
  const j = await getJson(`${config.kalshiBase}/markets?series_ticker=KXBTC15M&status=open&limit=5`);
  const m = (j?.markets ?? []).find((x: any) => Date.parse(x.open_time) <= now && now < Date.parse(x.close_time));
  if (m) cached = m;
  return m ?? null;
}

export async function fetchKalshi(now = Date.now()): Promise<VenueSnapshot | null> {
  const base = await findCurrent(now);
  if (!base) return null;
  // Quotes come from the polled orderbook cache (Kalshi books hold BIDS only: YES ask = 100 - best NO bid,
  // NO ask = 100 - best YES bid). The listing endpoint lags by seconds so it is never used. REST fallback only if the cache is stale.
  kalshiWatch(base.ticker);
  let top = kalshiTop(base.ticker), source: "ws" | "rest" = "ws";
  if (!top || Date.now() - top.ts > config.maxQuoteAgeMs) {
    const r = await fetchKalshiTop(base.ticker);
    if (r) { top = r; source = "rest"; }
  }
  const yesBid = top?.yesBid ?? null, noBid = top?.noBid ?? null;
  const m = base;
  const sp = brtiSpot(), fb = btcPrice();
  return {
    venue: "kalshi",
    marketId: m.ticker,
    title: `${m.title ?? "BTC Up or Down 15m"} (${m.ticker})`,
    strike: typeof m.floor_strike === "number" ? m.floor_strike : Number(m.floor_strike) || null,
    openTime: m.open_time,
    closeTime: m.close_time,
    upAsk: noBid === null ? null : realAsk(100 - noBid),
    downAsk: yesBid === null ? null : realAsk(100 - yesBid),
    upBid: yesBid,
    downBid: noBid,
    ts: Date.now(),
    spot: sp?.price ?? fb, spotSource: sp ? "brti-proxy" : fb !== null ? "coinbase-rest" : null,
    spotTs: sp ? sp.ts : fb !== null ? btcRestTs() : null, spotAvg60: brtiAvg60(),
    quoteSource: source, quoteAgeMs: top ? Date.now() - top.ts : null,
  };
}

export interface KalshiResult { result: Side | null; expirationValue: number | null; strike: number | null }
export async function fetchKalshiResult(ticker: string): Promise<KalshiResult | null> {
  const j = await getJson(`${config.kalshiBase}/markets/${ticker}`);
  const m = j?.market;
  if (!m) return null;
  const r = String(m.result ?? "").toLowerCase();
  return {
    result: r === "yes" ? "UP" : r === "no" ? "DOWN" : null,
    expirationValue: Number(m.expiration_value) || null,
    strike: Number(m.floor_strike) || null,
  };
}
