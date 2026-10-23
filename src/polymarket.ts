import { config } from "./config.ts";
import { chainlinkAvg60, chainlinkSpot } from "./feeds/chainlink.ts";
import { twapAt, twapAvg60, twapSpot } from "./feeds/polyLive.ts";
import { polyTop, setPolyTop, watchTokens } from "./feeds/polyBook.ts";
import { getJson, jsonArr, realAsk } from "./http.ts";
import { loadStrike, saveStrike, type StoredStrike } from "./db.ts";
import type { Side, VenueSnapshot } from "./types.ts";

interface Lookup { start: number; slug: string; title: string; upToken: string; downToken: string; openTime: string; closeTime: string; priceToBeat: number | null }
let cache: { start: number; lookup: Lookup | null; at: number } | null = null;

const slugFor = (startSec: number) => `btc-updown-15m-${startSec}`;
const fetchEvent = async (startSec: number) => (await getJson(`${config.gammaUrl}/events?slug=${slugFor(startSec)}`))?.[0] ?? null;

async function lookup(now: number): Promise<Lookup | null> {
  const start = Math.floor(now / 900_000) * 900;
  // cache per window; retry a failed lookup every 5s (the strike has its own cache, see resolveStrike)
  if (cache && cache.start === start && cache.lookup) return cache.lookup;
  if (cache && cache.start === start && !cache.lookup && now - cache.at < 5000) return null;
  const e = await fetchEvent(start);
  const m = e?.markets?.[0];
  const tokens = jsonArr(m?.clobTokenIds).map(String);
  const outs = jsonArr(m?.outcomes).map(String);
  let l: Lookup | null = null;
  if (m && tokens.length === 2) {
    const ui = Math.max(0, outs.findIndex((o) => o.toLowerCase() === "up"));
    l = {
      start,
      slug: e.slug ?? slugFor(start),
      title: e.title ?? m.question ?? slugFor(start),
      upToken: tokens[ui]!,
      downToken: tokens[1 - ui]!,
      openTime: new Date(start * 1000).toISOString(),
      closeTime: new Date(Date.parse(m.endDate ?? e.endDate) || (start + 900) * 1000).toISOString(),
      priceToBeat: Number(e.eventMetadata?.priceToBeat) || null,
    };
  }
  cache = { start, lookup: l, at: now };
  return l;
}

// ---------------------------------------------------------------------------------------------------------------------
// Price to Beat (strike). Polymarket's rule: Up wins if the Chainlink BTC/USD 60s-TWAP stream at window END >= its value
// at window START. So the strike is the Chainlink TWAP-60s value at windowStart (NOT the raw Chainlink spot tick).
// Priority (never any other price source):
//   1. gamma eventMetadata.priceToBeat           (official; only appears ~1-2 min after the window closes)
//   2. polymarket.com /api/crypto/crypto-price    (unofficial frontend endpoint the site uses for "Price To Beat";
//      openPrice with variant=fifteen&twapEnabled=true&twapLookbackSeconds=60 == eventMetadata.priceToBeat, verified live)
//   3. price.crypto.twap buffer at windowStart ±2s (authenticated live-data v2 feed = the resolution stream itself;
//      needs CLOB creds; UNVERIFIED live)
//   4. null -> dashboard shows "—"
// Deliberately NOT used: the public RTDS Chainlink *spot* tick at windowStart (measured $14 off the real strike) and a
// 60s mean of RTDS spot ticks (measured $0.1-$2 off): both are approximations, not the Price to Beat.
// Each window's strike is cached in memory and persisted in SQLite (strikes table) so a restart mid-window keeps it.
export const STRIKE_SOURCES = {
  priceToBeat: "polymarket priceToBeat",
  cryptoPrice: "polymarket crypto-price (chainlink twap60 @ window start)",
  twapFeed: "chainlink-twap@window-start",
} as const;
const RANK: Record<string, number> = Object.fromEntries(Object.values(STRIKE_SOURCES).map((s, i) => [s, i]));
const rank = (s: string) => RANK[s] ?? 99;
/** Sources that equal the official priceToBeat exactly; once we have one we stop looking. */
const final = (s: string) => rank(s) <= 1;

const WEB_URL = process.env.POLY_WEB_URL || "https://polymarket.com";
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
export interface CryptoPrice { openPrice: number | null; closePrice: number | null; completed: boolean }
/** Polymarket frontend endpoint (unofficial). variant=fifteen + twapEnabled are REQUIRED: without them it returns other numbers. */
export async function fetchCryptoPrice(startSec: number): Promise<CryptoPrice | null> {
  const q = new URLSearchParams({ symbol: "BTC", eventStartTime: iso(startSec), variant: "fifteen", endDate: iso(startSec + 900), twapEnabled: "true", twapLookbackSeconds: "60" });
  const j = await getJson<any>(`${WEB_URL}/api/crypto/crypto-price?${q}`, 4000);
  if (!j || typeof j !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return { openPrice: num(j.openPrice), closePrice: num(j.closePrice), completed: j.completed === true };
}

export interface StrikeDeps {
  fetchOpen(startSec: number): Promise<number | null>;
  twapAt(startSec: number): number | null;
  load(startSec: number): StoredStrike | null;
  save(startSec: number, value: number, source: string): void;
}
const safe = <T>(f: () => T, dflt: T): T => { try { return f(); } catch { return dflt; } };
export const defaultStrikeDeps: StrikeDeps = {
  fetchOpen: async (s) => (await fetchCryptoPrice(s))?.openPrice ?? null,
  twapAt: (s) => twapAt(s),
  load: (s) => safe(() => loadStrike(s, "polymarket"), null),
  save: (s, v, src) => safe(() => saveStrike(s, "polymarket", v, src), undefined),
};

export interface Strike { value: number; source: string }
const strikes = new Map<number, Strike | null>(); // windowStart -> best strike so far (null = looked in DB, none)
const lastFetch = new Map<number, number>();
export function resetStrikeCache() { strikes.clear(); lastFetch.clear(); }

/** Best known strike for a window, in the priority order above. Network call (crypto-price) throttled to 1 per 5s. */
export async function resolveStrike(startSec: number, priceToBeat: unknown, now = Date.now(), deps: StrikeDeps = defaultStrikeDeps): Promise<Strike | null> {
  if (!strikes.has(startSec)) strikes.set(startSec, deps.load(startSec));
  for (const k of strikes.keys()) if (k < startSec - 7200) { strikes.delete(k); lastFetch.delete(k); }
  let cur = strikes.get(startSec) ?? null;
  const take = (value: number | null, source: string) => {
    if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) return false;
    if (cur && rank(cur.source) <= rank(source) && (cur.source !== source || cur.value === value)) return true; // already as good
    cur = { value, source };
    strikes.set(startSec, cur);
    deps.save(startSec, value, source);
    return true;
  };
  if (take(Number(priceToBeat) || null, STRIKE_SOURCES.priceToBeat)) return cur;
  if (cur && final(cur.source)) return cur;
  const lf = lastFetch.get(startSec);
  if (lf === undefined || now - lf >= 5000) {
    lastFetch.set(startSec, now);
    const open = await deps.fetchOpen(startSec).catch(() => null);
    if (take(open, STRIKE_SOURCES.cryptoPrice)) return cur;
  }
  take(deps.twapAt(startSec), STRIKE_SOURCES.twapFeed);
  return cur;
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
  const sk = await resolveStrike(l.start, l.priceToBeat, now);
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
  // Chainlink 60s TWAP (authenticated live-data WS) is primary when fresh; the public RTDS Chainlink feed is the fallback.
  const cl = twapSpot(); // resolution price only (TWAP); no plain-spot substitute
  return {
    venue: "polymarket", marketId: l.slug, title: l.title, strike: sk?.value ?? null,
    openTime: l.openTime, closeTime: l.closeTime,
    upAsk: realAsk(u?.ask ?? null), downAsk: realAsk(d?.ask ?? null), upBid: u?.bid ?? null, downBid: d?.bid ?? null, ts: t,
    spot: cl?.price ?? null, spotSource: cl ? cl.source : null,
    spotTs: cl ? cl.ts : null, spotAvg60: null,
    spotSettle: null, spotError: cl ? null : "no Chainlink 60s TWAP (needs POLY_API_KEY / POLY_API_SECRET / POLY_API_PASSPHRASE for Polymarket live-data)",
    strikeSource: sk?.source ?? null,
    quoteSource: u?.rest || d?.rest ? "rest" : "ws",
    quoteAgeMs: u && d ? t - Math.min(u.ts, d.ts) : null,
  };
}

export interface PolyResult { result: Side | null; strike: number | null; finalPrice: number | null }
/** Resolved only when the market is closed and outcomePrices is a clean 1/0. */
/** strike/finalPrice: gamma eventMetadata first; gamma often lacks finalPrice (it is only filled when the NEXT window
 *  resolves), so fall back to our stored strike and the crypto-price endpoint (same Chainlink TWAP-60s numbers). */
export async function fetchPolyResult(closeTimeIso: string, deps: { fetchCp?: typeof fetchCryptoPrice; load?: StrikeDeps["load"] } = {}): Promise<PolyResult | null> {
  const start = Math.round(Date.parse(closeTimeIso) / 1000) - 900;
  const e = await fetchEvent(start);
  const m = e?.markets?.[0];
  if (!m) return null;
  const prices = jsonArr(m.outcomePrices).map(Number);
  const outs = jsonArr(m.outcomes).map((o) => String(o).toLowerCase());
  const ui = Math.max(0, outs.indexOf("up"));
  const resolved = m.closed === true && prices.length === 2 && prices.every((p) => p === 0 || p === 1) && prices[0] !== prices[1];
  let strike = Number(e.eventMetadata?.priceToBeat) || null;
  let finalPrice = Number(e.eventMetadata?.finalPrice) || null;
  if (strike === null) strike = (deps.load ?? defaultStrikeDeps.load)(start)?.value ?? null;
  if (strike === null || finalPrice === null) {
    const cp = await (deps.fetchCp ?? fetchCryptoPrice)(start).catch(() => null);
    strike ??= cp?.openPrice ?? null;
    if (cp?.completed) finalPrice ??= cp.closePrice;
  }
  return { result: resolved ? (prices[ui] === 1 ? "UP" : "DOWN") : null, strike, finalPrice };
}
