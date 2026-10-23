import { config } from "./config.ts";
import { btcAtWindowStart, btcPrice, btcRestTs } from "./btc.ts";
import { chainlinkAvg60, chainlinkSpot } from "./feeds/chainlink.ts";
import { polyTop, setPolyTop, watchTokens } from "./feeds/polyBook.ts";
import { getJson, jsonArr, realAsk } from "./http.ts";
import type { Side, VenueSnapshot } from "./types.ts";

interface Lookup { slug: string; title: string; upToken: string; downToken: string; openTime: string; closeTime: string; strike: number | null }
let cache: { start: number; lookup: Lookup | null; at: number } | null = null;

const slugFor = (startSec: number) => `btc-updown-15m-${startSec}`;
const fetchEvent = async (startSec: number) => (await getJson(`${config.gammaUrl}/events?slug=${slugFor(startSec)}`))?.[0] ?? null;

async function lookup(now: number): Promise<Lookup | null> {
  const start = Math.floor(now / 900_000) * 900;
  // cache per window; retry a failed lookup every 5s, refresh a missing strike every 60s
  if (cache && cache.start === start && cache.lookup && (cache.lookup.strike !== null || now - cache.at < 60_000)) return cache.lookup;
  if (cache && cache.start === start && !cache.lookup && now - cache.at < 5000) return null;
  const e = await fetchEvent(start);
  const m = e?.markets?.[0];
  const tokens = jsonArr(m?.clobTokenIds).map(String);
  const outs = jsonArr(m?.outcomes).map(String);
  let l: Lookup | null = null;
  if (m && tokens.length === 2) {
    const ui = Math.max(0, outs.findIndex((o) => o.toLowerCase() === "up"));
    const strike = Number(e.eventMetadata?.priceToBeat) || btcAtWindowStart(start);
    l = {
      slug: e.slug ?? slugFor(start),
      title: e.title ?? m.question ?? slugFor(start),
      upToken: tokens[ui]!,
      downToken: tokens[1 - ui]!,
      openTime: new Date(start * 1000).toISOString(),
      closeTime: new Date(Date.parse(m.endDate ?? e.endDate) || (start + 900) * 1000).toISOString(),
      strike: strike || null,
    };
  }
  cache = { start, lookup: l, at: now };
  return l;
}

/** REST orderbook (fallback only). Sides are not guaranteed sorted: best ask = MIN, best bid = MAX. */
async function restBook(token: string) {
  const b = await getJson(`${config.clobUrl}/book?token_id=${token}`);
  if (!b) return null;
  const px = (a: any) => (Array.isArray(a) ? a.filter((x) => Number(x.size) > 0).map((x) => Number(x.price) * 100).filter(Number.isFinite) : []);
  const asks = px(b.asks), bids = px(b.bids);
  return { ask: asks.length ? realAsk(Math.min(...asks)) : null, bid: bids.length ? Math.max(...bids) : null };
}

let lastRest = 0;
export async function fetchPolymarket(now = Date.now()): Promise<VenueSnapshot | null> {
  const l = await lookup(now);
  if (!l) return null;
  watchTokens(l.upToken, l.downToken);
  let u = polyTop(l.upToken), d = polyTop(l.downToken);
  const stale = (t: typeof u) => !t || Date.now() - t.ts > config.maxQuoteAgeMs;
  if ((stale(u) || stale(d)) && Date.now() - lastRest >= 2000) { // quiet or disconnected WS book: confirm via REST (throttled)
    lastRest = Date.now();
    const [ru, rd] = await Promise.all([restBook(l.upToken), restBook(l.downToken)]);
    if (ru) setPolyTop(l.upToken, ru.ask, ru.bid);
    if (rd) setPolyTop(l.downToken, rd.ask, rd.bid);
    u = polyTop(l.upToken); d = polyTop(l.downToken);
  }
  const t = Date.now();
  const cl = chainlinkSpot(), fb = btcPrice();
  return {
    venue: "polymarket", marketId: l.slug, title: l.title, strike: l.strike,
    openTime: l.openTime, closeTime: l.closeTime,
    upAsk: realAsk(u?.ask ?? null), downAsk: realAsk(d?.ask ?? null), upBid: u?.bid ?? null, downBid: d?.bid ?? null, ts: t,
    spot: cl?.price ?? fb, spotSource: cl ? "chainlink" : fb !== null ? "coinbase-rest" : null,
    spotTs: cl ? cl.ts : fb !== null ? btcRestTs() : null, spotAvg60: chainlinkAvg60(),
    quoteSource: u?.rest || d?.rest ? "rest" : "ws",
    quoteAgeMs: u && d ? t - Math.min(u.ts, d.ts) : null,
  };
}

export interface PolyResult { result: Side | null; strike: number | null; finalPrice: number | null }
/** Resolved only when the market is closed and outcomePrices is a clean 1/0. */
export async function fetchPolyResult(closeTimeIso: string): Promise<PolyResult | null> {
  const e = await fetchEvent(Date.parse(closeTimeIso) / 1000 - 900);
  const m = e?.markets?.[0];
  if (!m) return null;
  const prices = jsonArr(m.outcomePrices).map(Number);
  const outs = jsonArr(m.outcomes).map((o) => String(o).toLowerCase());
  const ui = Math.max(0, outs.indexOf("up"));
  const resolved = m.closed === true && prices.length === 2 && prices.every((p) => p === 0 || p === 1) && prices[0] !== prices[1];
  return {
    result: resolved ? (prices[ui] === 1 ? "UP" : "DOWN") : null,
    strike: Number(e.eventMetadata?.priceToBeat) || null,
    finalPrice: Number(e.eventMetadata?.finalPrice) || null,
  };
}
