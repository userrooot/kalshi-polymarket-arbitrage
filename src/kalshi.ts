import { config } from "./config.ts";
import { getJson, realAsk } from "./http.ts";
import type { Side, VenueSnapshot } from "./types.ts";

const cents = (d: unknown) => (d === undefined || d === null || d === "" ? null : Number(d) * 100);
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
  const j = await getJson(`${config.kalshiBase}/markets/${base.ticker}`); // fresh prices each tick
  const fresh = j?.market ?? null;
  // Never fall back to the cached listing's quotes: they can be minutes old and would create phantom trades.
  const m = fresh ?? base;
  const q = (v: unknown) => (fresh ? v : null);
  return {
    venue: "kalshi",
    marketId: m.ticker,
    title: `${m.title ?? "BTC Up or Down 15m"} (${m.ticker})`,
    strike: typeof m.floor_strike === "number" ? m.floor_strike : Number(m.floor_strike) || null,
    openTime: m.open_time,
    closeTime: m.close_time,
    upAsk: realAsk(cents(q(m.yes_ask_dollars))),
    downAsk: realAsk(cents(q(m.no_ask_dollars))),
    upBid: bid(cents(q(m.yes_bid_dollars))),
    downBid: bid(cents(q(m.no_bid_dollars))),
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
