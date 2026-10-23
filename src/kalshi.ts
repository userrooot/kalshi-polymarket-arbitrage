import { config } from "./config.ts";
import { getJson, realAsk } from "./http.ts";
import type { Side, VenueSnapshot } from "./types.ts";

const bid = (c: number | null) => (c !== null && Number.isFinite(c) && c > 0 ? c : null);

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
  // Live quotes from the orderbook: GET /markets/{ticker} lags the book by several seconds, which pairs a stale
  // Kalshi price with a fresh Polymarket book and fakes arbs. Kalshi books hold BIDS only:
  // YES ask = 100 - best NO bid, NO ask = 100 - best YES bid. Never fall back to stale listing quotes.
  const j = await getJson(`${config.kalshiBase}/markets/${base.ticker}/orderbook`);
  const ob = j?.orderbook_fp ?? j?.orderbook ?? null;
  const best = (lv: unknown) => {
    const px = (Array.isArray(lv) ? lv : []).filter((l: any) => Number(l?.[1]) > 0).map((l: any) => Number(l[0]) * 100).filter(Number.isFinite);
    return px.length ? Math.round(Math.max(...px) * 100) / 100 : null;
  };
  const yesBid = ob ? bid(best(ob.yes_dollars)) : null, noBid = ob ? bid(best(ob.no_dollars)) : null;
  const m = base;
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
