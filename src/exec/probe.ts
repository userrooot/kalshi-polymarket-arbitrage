// Latency probe (`bun run probe`, meant to run on the UK server). Measures round-trip times to both venues, estimates the
// local clock offset, and writes data/latency.json (a LatencyProfile + `meta`). Read-only by default. Real-money calibration
// is HARD-GATED (CALIBRATE_LIVE=1 + --live + typed confirmation) and never places resting orders.
import { createHmac, randomUUID, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { config } from "../config.ts";
import { KalshiBook } from "../feeds/kalshiOrderbook.ts";
import { kalshiHeaders, loadPrivateKey } from "../feeds/kalshiAuth.ts";
import { config2 } from "./config2.ts";
import { defaultProfile } from "./latency.ts";
import type { LatencyComponent, LatencyProfile, VenueLatency } from "./types.ts";

export const MAX_SAMPLES = 2000;
export const CONFIRM_PHRASE = "I UNDERSTAND THIS USES REAL MONEY";
const POLY_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// ------------------------------------------------------------------------------------------------ stats / profile
export interface Summary { n: number; min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null; mean: number | null }
export function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}
export function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  const r = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  return { n: s.length, min: r(s[0] ?? null), p50: r(quantile(s, 0.5)), p95: r(quantile(s, 0.95)), p99: r(quantile(s, 0.99)), max: r(s[s.length - 1] ?? null), mean: s.length ? r(s.reduce((a, b) => a + b, 0) / s.length) : null };
}
/** Keep at most `cap` samples, evenly thinned (deterministic). */
export function capSamples(xs: number[], cap = MAX_SAMPLES): number[] {
  if (xs.length <= cap) return xs.map((x) => Math.round(x * 1000) / 1000);
  const out: number[] = [];
  for (let i = 0; i < cap; i++) out.push(Math.round(xs[Math.floor((i * xs.length) / cap)]! * 1000) / 1000);
  return out;
}

/** Conservative built-in profile used for components the probe cannot measure (also the base when A's defaults are absent). */
export function fallbackProfile(): LatencyProfile {
  const ln = (medianMs: number, sigma: number): LatencyComponent => ({ kind: "lognormal", medianMs, sigma });
  return {
    source: "default",
    polymarket: { feedDelay: ln(8, 0.5), sendOneWay: ln(3, 0.3), process: ln(2, 0.5), ackOneWay: ln(3, 0.3) },
    kalshi: { feedDelay: ln(45, 0.6), sendOneWay: ln(45, 0.3), process: ln(5, 0.5), ackOneWay: ln(45, 0.3) },
  };
}
const empirical = (samples: number[], fb: LatencyComponent): LatencyComponent =>
  samples.length >= 5 ? { kind: "empirical", samples: capSamples(samples) } : fb;

export interface Measurements {
  polyWsRtt: number[]; polyBookRtt: number[]; polyTimeRtt: number[]; polyAuthRtt: number[];
  kalshiWsRtt: number[]; kalshiStatusRtt: number[]; kalshiBookRtt: number[]; kalshiBalanceRtt: number[];
  demoOrderRtt: number[]; demoOrderTsOffset: number[];
  polyServerTimeOffsetMs: number[];
}
export const emptyMeasurements = (): Measurements => ({
  polyWsRtt: [], polyBookRtt: [], polyTimeRtt: [], polyAuthRtt: [], kalshiWsRtt: [], kalshiStatusRtt: [], kalshiBookRtt: [],
  kalshiBalanceRtt: [], demoOrderRtt: [], demoOrderTsOffset: [], polyServerTimeOffsetMs: [],
});

/** One-way estimates are RTT/2 (symmetry assumption: trust RTT over one-way clock-based numbers). */
export function buildProfile(m: Measurements, base: LatencyProfile = fallbackProfile()): LatencyProfile {
  const half = (xs: number[]) => xs.map((x) => x / 2);
  const pick = (...cands: number[][]) => cands.find((c) => c.length >= 5) ?? [];
  const pRtt = pick(m.polyWsRtt, m.polyBookRtt, m.polyTimeRtt);
  const kRtt = pick(m.kalshiWsRtt, m.kalshiBookRtt, m.kalshiStatusRtt, m.kalshiBalanceRtt);
  const poly: VenueLatency = { ...base.polymarket };
  const kal: VenueLatency = { ...base.kalshi };
  if (pRtt.length) { poly.sendOneWay = empirical(half(pRtt), poly.sendOneWay); poly.ackOneWay = empirical(half(pRtt), poly.ackOneWay); }
  if (kRtt.length) { kal.sendOneWay = empirical(half(kRtt), kal.sendOneWay); kal.ackOneWay = empirical(half(kRtt), kal.ackOneWay); }
  // Matching/processing time at Kalshi: demo order RTT minus the network baseline (UNVERIFIED: demo != production).
  if (m.demoOrderRtt.length >= 5 && kRtt.length) {
    const base50 = quantile([...kRtt].sort((a, b) => a - b), 0.5)!;
    kal.process = empirical(m.demoOrderRtt.map((x) => Math.max(0.5, x - base50)), kal.process);
  }
  return { polymarket: poly, kalshi: kal, source: "probe" };
}

export interface ProbeMeta {
  generatedAt: string; host: string; clockOffsetMs: number | null; chrony: string | null;
  measurements: Record<string, Summary>; notes: string[]; unverified: string[]; demo: DemoReport | null;
}
export type LatencyFile = LatencyProfile & { meta: ProbeMeta };

export function writeLatencyJson(path: string, profile: LatencyProfile, meta: ProbeMeta): LatencyFile {
  const out: LatencyFile = { ...profile, meta };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(out));
  return out;
}

// ------------------------------------------------------------------------------------------------ Polymarket L2 auth
/** Polymarket CLOB L2 headers. message = ts + METHOD + path + body; HMAC-SHA256 keyed by base64-decoded secret; URL-safe base64 (padded).
 *  Source: docs.polymarket.com authentication page. POLY_ADDRESS is the signer's Polygon address (public). */
export function polyL2Headers(c: { apiKey: string; secret: string; passphrase: string; address: string }, method: string, path: string, body = "", tsSec = Math.floor(Date.now() / 1000)): Record<string, string> {
  const key = Buffer.from(c.secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const sig = createHmac("sha256", key).update(`${tsSec}${method.toUpperCase()}${path}${body}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return { POLY_ADDRESS: c.address, POLY_SIGNATURE: sig, POLY_TIMESTAMP: String(tsSec), POLY_API_KEY: c.apiKey, POLY_PASSPHRASE: c.passphrase };
}

// ------------------------------------------------------------------------------------------------ deps
export interface WSLike {
  onopen: ((e?: any) => void) | null; onmessage: ((e: { data: any }) => void) | null; onerror: ((e?: any) => void) | null; onclose: ((e?: any) => void) | null;
  send(s: string): void; close(): void; ping?: () => void; addEventListener?: (t: string, f: (e?: any) => void) => void;
}
export interface ProbeDeps {
  fetch: typeof fetch;
  now: () => number;                 // high-res epoch ms
  sleep: (ms: number) => Promise<void>;
  wsFactory: (url: string, headers?: Record<string, string>) => WSLike;
  env: Record<string, string | undefined>;
  chrony: () => Promise<string | null>;
  log: (s: string) => void;
}
export const defaultDeps = (): ProbeDeps => ({
  fetch: ((...a: Parameters<typeof fetch>) => fetch(...a)) as typeof fetch,
  now: () => performance.timeOrigin + performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  wsFactory: (url, headers) => {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const opts: any = {};
    if (proxy) opts.proxy = proxy;
    if (headers) opts.headers = headers;
    return (Object.keys(opts).length ? new WebSocket(url, opts) : new WebSocket(url)) as unknown as WSLike;
  },
  env: process.env,
  chrony: async () => {
    try {
      const p = Bun.spawn(["chronyc", "tracking"], { stdout: "pipe", stderr: "ignore" });
      const t = await new Response(p.stdout).text();
      return t.trim() || null;
    } catch { return null; }
  },
  log: (s) => console.log(s),
});

/** Time one HTTP request (until the body is fully read). Returns ms or null on failure; status is returned too. */
async function timed(d: ProbeDeps, url: string, init?: RequestInit): Promise<{ ms: number | null; status: number; text: string; wall: number }> {
  const t0 = d.now();
  try {
    const r = await d.fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    return { ms: d.now() - t0, status: r.status, text, wall: t0 };
  } catch { return { ms: null, status: 0, text: "", wall: t0 }; }
}
/** Repeat a probe n times (first sample dropped as connection warm-up when n>1), spaced by gapMs. */
async function series(d: ProbeDeps, n: number, gapMs: number, f: () => Promise<number | null>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = await f();
    if (v !== null && (i > 0 || n === 1)) out.push(v);
    if (i < n - 1) await d.sleep(gapMs);
  }
  return out.slice(-MAX_SAMPLES);
}

// ------------------------------------------------------------------------------------------------ WebSocket RTT
/** App-level ping over a WebSocket: `send` is written, `isReply(data)` identifies the answer. Returns RTT samples (ms). */
export async function wsRtt(d: ProbeDeps, url: string, o: { headers?: Record<string, string>; n: number; gapMs: number; makePing: (i: number) => string; isReply: (data: string, i: number) => boolean; nativePing?: boolean }): Promise<number[]> {
  const ws = d.wsFactory(url, o.headers);
  const out: number[] = [];
  let waiter: ((data: string) => void) | null = null;
  const opened = new Promise<boolean>((res) => {
    const to = setTimeout(() => res(false), 6000);
    ws.onopen = () => { clearTimeout(to); res(true); };
    ws.onerror = () => { clearTimeout(to); res(false); };
    ws.onclose = () => res(false);
  });
  ws.onmessage = (e) => { const f = waiter; if (f) f(typeof e.data === "string" ? e.data : String(e.data)); };
  if (!(await opened)) { try { ws.close(); } catch {} return out; }
  for (let i = 0; i < o.n; i++) {
    const t0 = d.now();
    const got = await new Promise<boolean>((res) => {
      const to = setTimeout(() => { waiter = null; res(false); }, 3000);
      waiter = (data) => { if (o.isReply(data, i)) { clearTimeout(to); waiter = null; res(true); } };
      try { ws.send(o.makePing(i)); } catch { clearTimeout(to); res(false); }
    });
    if (got && (i > 0 || o.n === 1)) out.push(d.now() - t0);
    if (i < o.n - 1) await d.sleep(o.gapMs);
  }
  try { ws.close(); } catch {}
  return out;
}

// ------------------------------------------------------------------------------------------------ Kalshi helpers
export interface KalshiCreds { keyId: string; key: KeyObject }
const priceStr = (cents: number) => (Math.round(cents) / 100).toFixed(2);

async function kalshiSigned(d: ProbeDeps, base: string, c: KalshiCreds, method: string, pathAndQuery: string, body?: unknown) {
  const url = base + pathAndQuery;
  const signPath = new URL(url).pathname; // signature excludes the query string
  const headers: Record<string, string> = { accept: "application/json", ...kalshiHeaders(c.keyId, c.key, signPath, method, Math.round(d.now())) };
  if (body !== undefined) headers["content-type"] = "application/json";
  return timed(d, url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const safeJson = (t: string): any => { try { return JSON.parse(t); } catch { return null; } };
const errBrief = (status: number, text: string) => { const j = safeJson(text); return `HTTP ${status}${j?.error?.code ? ` ${j.error.code}` : j?.code ? ` ${j.code}` : ""}`; };

/** Best YES ask in cents from a Kalshi REST orderbook payload (NO bids are in NO terms there). */
export function kalshiYesAsk(payload: any): number | null {
  const ob = payload?.orderbook_fp ?? payload?.orderbook;
  if (!ob) return null;
  const b = new KalshiBook(false);
  b.snapshot(ob);
  return b.asks().upAsk;
}

// ------------------------------------------------------------------------------------------------ Kalshi demo orders
export interface DemoReport {
  base: string; status: "ok" | "skipped" | "unsupported" | "error"; detail: string; ticker?: string;
  orders: { rttMs: number; httpStatus: number; tsMs: number | null; fillCount: string | null; avgFee: string | null; clockOffsetMs: number | null }[];
}
export async function runKalshiDemo(d: ProbeDeps, m: Measurements, n = 5): Promise<DemoReport> {
  const base = config2.kalshiDemoBase;
  const rep: DemoReport = { base, status: "skipped", detail: "", orders: [] };
  const keyId = config2.kalshiDemoKeyId;
  const keyPath = config2.kalshiDemoKeyPath;
  if (!keyId || !keyPath) { rep.detail = "KALSHI_DEMO_API_KEY_ID / KALSHI_DEMO_PRIVATE_KEY_PATH not set"; return rep; }
  let creds: KalshiCreds;
  try { creds = { keyId, key: loadPrivateKey({ path: keyPath })! }; } catch { rep.status = "error"; rep.detail = "could not load demo private key"; return rep; }
  const list = await kalshiSigned(d, base, creds, "GET", "/markets?status=open&limit=200");
  const markets: any[] = safeJson(list.text)?.markets ?? [];
  if (list.status !== 200 || !markets.length) { rep.status = "error"; rep.detail = `listing demo markets failed: ${errBrief(list.status, list.text)} (${markets.length} markets)`; return rep; }
  // Find a liquid market: has a YES ask in (2, 98) cents.
  let pick: { ticker: string; ask: number } | null = null;
  for (const mk of markets.slice(0, 30)) {
    const ob = await kalshiSigned(d, base, creds, "GET", `/markets/${encodeURIComponent(mk.ticker)}/orderbook?depth=5`);
    if (ob.ms !== null && ob.status === 200) m.kalshiBookRtt.push(ob.ms);
    const ask = kalshiYesAsk(safeJson(ob.text));
    if (ask !== null && ask > 2 && ask < 98) { pick = { ticker: mk.ticker, ask }; break; }
  }
  d.log(`[probe] demo: ${markets.length} open markets listed; liquid market: ${pick ? pick.ticker + " (YES ask " + pick.ask + "c)" : "none"}`);
  if (!pick) { rep.status = "unsupported"; rep.detail = `no demo market with a YES ask among the first ${Math.min(30, markets.length)}`; return rep; }
  rep.ticker = pick.ticker;
  for (let i = 0; i < n; i++) {
    const ob = await kalshiSigned(d, base, creds, "GET", `/markets/${encodeURIComponent(pick.ticker)}/orderbook?depth=5`);
    const ask = kalshiYesAsk(safeJson(ob.text)) ?? pick.ask;
    // Create Order V2 (docs.kalshi.com/api-reference/orders/create-order-v2): bid = buy YES, IOC, mock funds on demo.
    const body = { ticker: pick.ticker, side: "bid", count: "1", price: priceStr(ask), time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", client_order_id: `probe-${randomUUID()}` };
    const r = await kalshiSigned(d, base, creds, "POST", "/portfolio/events/orders", body);
    const j = safeJson(r.text);
    if (r.status === 404 || r.status === 405) { rep.status = "unsupported"; rep.detail = `demo rejected POST /portfolio/events/orders (${errBrief(r.status, r.text)})`; return rep; }
    if (r.ms === null) continue;
    const tsMs = typeof j?.ts_ms === "number" ? j.ts_ms : null;
    const off = tsMs !== null ? tsMs - (r.wall + r.ms / 2) : null;
    rep.orders.push({ rttMs: r.ms, httpStatus: r.status, tsMs, fillCount: j?.fill_count ?? null, avgFee: j?.average_fee_paid ?? null, clockOffsetMs: off });
    if (r.status === 201) { m.demoOrderRtt.push(r.ms); if (off !== null) m.demoOrderTsOffset.push(off); }
    await d.sleep(1000);
  }
  const ok = rep.orders.filter((o) => o.httpStatus === 201).length;
  rep.status = ok ? "ok" : "error";
  rep.detail = ok ? `${ok}/${rep.orders.length} demo orders accepted (HTTP 201)` : `no order accepted: statuses ${rep.orders.map((o) => o.httpStatus).join(",") || "none"}`;
  return rep;
}

// ------------------------------------------------------------------------------------------------ real-money gate
export interface LiveGateInput { env: Record<string, string | undefined>; argv: string[]; typed: string | null }
export function checkLiveGates(i: LiveGateInput): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (i.env.CALIBRATE_LIVE !== "1") missing.push("CALIBRATE_LIVE=1");
  if (!i.argv.includes("--live")) missing.push("--live flag");
  if (i.typed !== CONFIRM_PHRASE) missing.push(`typed confirmation '${CONFIRM_PHRASE}'`);
  return { ok: missing.length === 0, missing };
}

export class NotImplementedError extends Error {}
/** Polymarket FOK probe far below the ask. NOT IMPLEMENTED on purpose: order signing (EIP-712 with the wallet private key, salt/maker/
 *  signer/signatureType fields, neg-risk exchange variants) could not be verified here, and we do not guess at financial APIs. */
export async function placePolyFokProbe(_tokenId: string): Promise<never> {
  throw new NotImplementedError("not implemented: Polymarket CLOB order construction/EIP-712 signing is UNVERIFIED; use the official client to wire this up manually");
}

export interface LiveOpts { deps: ProbeDeps; argv: string[]; ask: (q: string) => Promise<string>; maxOrders?: number; minGapMs?: number }
export interface LiveReport { refused: string[]; kalshi: { rttMs: number; httpStatus: number; tsMs: number | null }[]; poly: string }
/** Opt-in real-money calibration. Verifies ALL gates before any network call. Kalshi: IOC YES bid >=10c below best ask, 1 contract
 *  (cannot match, never rests). Polymarket: stub. Max 1 order / 10 s, capped count. */
export async function runLiveCalibration(o: LiveOpts): Promise<LiveReport> {
  const rep: LiveReport = { refused: [], kalshi: [], poly: "not run" };
  const pre = checkLiveGates({ env: o.deps.env, argv: o.argv, typed: CONFIRM_PHRASE });
  const early = pre.missing.filter((x) => !x.startsWith("typed"));
  if (early.length) { rep.refused = early; return rep; }
  const cap = Math.min(o.maxOrders ?? 3, 10);
  o.deps.log(`[probe] REAL-MONEY calibration requested: up to ${cap} Kalshi IOC buys of 1 contract at >=10c below best ask (cannot fill; never resting), 1 per 10s. Polymarket part is a stub.`);
  const typed = await o.ask(`Type exactly '${CONFIRM_PHRASE}' to continue: `);
  const g = checkLiveGates({ env: o.deps.env, argv: o.argv, typed: typed.trim() });
  if (!g.ok) { rep.refused = g.missing; return rep; }
  const keyId = config.kalshiApiKeyId;
  let key: KeyObject | null = null;
  try { key = loadPrivateKey({ pem: config.kalshiPrivateKey, path: config.kalshiPrivateKeyPath }); } catch {}
  if (!keyId || !key) { rep.refused = ["Kalshi API key not configured"]; return rep; }
  const creds = { keyId, key };
  const mk = safeJson((await kalshiSigned(o.deps, config.kalshiBase, creds, "GET", "/markets?series_ticker=KXBTC15M&status=open&limit=1")).text)?.markets?.[0];
  if (!mk) { rep.refused = ["no open KXBTC15M market"]; return rep; }
  for (let i = 0; i < cap; i++) {
    const ob = await kalshiSigned(o.deps, config.kalshiBase, creds, "GET", `/markets/${mk.ticker}/orderbook?depth=5`);
    const ask = kalshiYesAsk(safeJson(ob.text));
    const px = ask === null ? null : Math.floor(ask) - 10;
    if (px === null || px < 1) { o.deps.log("[probe] live: no safe price (<=1c) or no ask; skipping"); continue; }
    const body = { ticker: mk.ticker, side: "bid", count: "1", price: priceStr(px), time_in_force: "immediate_or_cancel", self_trade_prevention_type: "taker_at_cross", client_order_id: `cal-${randomUUID()}` };
    const r = await kalshiSigned(o.deps, config.kalshiBase, creds, "POST", "/portfolio/events/orders", body);
    const j = safeJson(r.text);
    rep.kalshi.push({ rttMs: r.ms ?? -1, httpStatus: r.status, tsMs: typeof j?.ts_ms === "number" ? j.ts_ms : null });
    if (i < cap - 1) await o.deps.sleep(o.minGapMs ?? 10_000);
  }
  try { await placePolyFokProbe(""); } catch (e) { rep.poly = e instanceof NotImplementedError ? `stub: ${e.message}` : "error"; }
  return rep;
}

// ------------------------------------------------------------------------------------------------ main probe
export interface ProbeOpts { n?: number; gapMs?: number; out?: string; demo?: boolean; deps?: ProbeDeps }
export async function runProbe(opts: ProbeOpts = {}): Promise<LatencyFile> {
  const d = opts.deps ?? defaultDeps();
  const n = opts.n ?? 30, gap = opts.gapMs ?? 150;
  const m = emptyMeasurements();
  const unverified: string[] = [], notes: string[] = [];
  const log = d.log;
  const polyBase = config.clobUrl;

  // --- Polymarket
  const start = Math.floor(Date.now() / 900_000) * 900;
  const ev = safeJson((await timed(d, `${config.gammaUrl}/events?slug=btc-updown-15m-${start}`)).text);
  let token = "";
  try { const t = ev?.[0]?.markets?.[0]?.clobTokenIds; token = (typeof t === "string" ? JSON.parse(t) : t)?.[0] ?? ""; } catch {}
  log(`[probe] Polymarket: token ${token ? token.slice(0, 8) + "..." : "(none found; /book skipped)"}`);
  m.polyWsRtt = await wsRtt(d, POLY_WS, { n, gapMs: gap, makePing: () => "PING", isReply: (s) => s === "PONG" });
  if (!m.polyWsRtt.length) unverified.push("Polymarket WS PING/PONG RTT: no PONG received (connection or protocol mismatch)");
  if (token) m.polyBookRtt = await series(d, n, gap, async () => (await timed(d, `${polyBase}/book?token_id=${token}`)).ms);
  m.polyTimeRtt = await series(d, n, gap, async () => {
    const t0 = d.now();
    const r = await timed(d, `${polyBase}/time`);
    const sec = Number(r.text.trim());
    if (r.ms !== null && Number.isFinite(sec) && sec > 1e9) m.polyServerTimeOffsetMs.push(sec * 1000 - (t0 + r.ms / 2)); // 1s resolution: coarse
    return r.ms;
  });
  const pc = { apiKey: config.polyApiKey, secret: config.polyApiSecret, passphrase: config.polyApiPassphrase, address: d.env.POLY_ADDRESS };
  if (pc.apiKey && pc.secret && pc.passphrase && pc.address) {
    // GET /data/orders is the authenticated read named in the docs example (read-only listing of OUR open orders).
    m.polyAuthRtt = await series(d, Math.min(n, 15), 300, async () => {
      const h = polyL2Headers({ apiKey: pc.apiKey!, secret: pc.secret!, passphrase: pc.passphrase!, address: pc.address! }, "GET", "/data/orders");
      const r = await timed(d, `${polyBase}/data/orders`, { headers: { accept: "application/json", ...h } });
      return r.status === 200 ? r.ms : null;
    });
    if (!m.polyAuthRtt.length) unverified.push("Polymarket authenticated GET /data/orders: no 200 response (needs POLY_ADDRESS = signer address; signing recipe per docs, UNVERIFIED live)");
  } else notes.push("Polymarket authenticated read skipped (POLY_API_KEY/SECRET/PASSPHRASE + POLY_ADDRESS not all set)");

  // --- Kalshi
  const kBase = config.kalshiBase;
  m.kalshiStatusRtt = await series(d, n, gap, async () => (await timed(d, `${kBase}/exchange/status`)).ms);
  const mk = safeJson((await timed(d, `${kBase}/markets?series_ticker=KXBTC15M&status=open&limit=5`)).text)?.markets?.[0];
  if (mk?.ticker) m.kalshiBookRtt = await series(d, n, gap, async () => (await timed(d, `${kBase}/markets/${mk.ticker}/orderbook?depth=5`)).ms);
  let kc: KalshiCreds | null = null;
  try { const key = loadPrivateKey({ pem: config.kalshiPrivateKey, path: config.kalshiPrivateKeyPath }); if (config.kalshiApiKeyId && key) kc = { keyId: config.kalshiApiKeyId, key }; } catch { notes.push("Kalshi private key unreadable"); }
  if (kc) {
    m.kalshiBalanceRtt = await series(d, Math.min(n, 15), 300, async () => { const r = await kalshiSigned(d, kBase, kc!, "GET", "/portfolio/balance"); return r.status === 200 ? r.ms : null; });
    if (!m.kalshiBalanceRtt.length) unverified.push("Kalshi signed GET /portfolio/balance returned no 200");
    const wsPath = new URL(config.kalshiWsUrl).pathname;
    m.kalshiWsRtt = await wsRtt(d, config.kalshiWsUrl, {
      headers: kalshiHeaders(kc.keyId, kc.key, wsPath), n: Math.min(n, 15), gapMs: 300,
      makePing: (i) => JSON.stringify({ id: i + 1, cmd: "list_subscriptions" }), isReply: (s, i) => { const j = safeJson(s); return !!j && j.id === i + 1; },
    });
    unverified.push("Kalshi WS RTT uses an app-level 'list_subscriptions' command round trip (not a protocol ping frame); UNVERIFIED");
  } else notes.push("Kalshi signed calls + WS RTT skipped (KALSHI_API_KEY_ID + private key not set)");

  // --- Kalshi demo
  let demo: DemoReport | null = null;
  if (opts.demo !== false) demo = await runKalshiDemo(d, m);
  if (demo) log(`[probe] Kalshi demo: ${demo.status} - ${demo.detail}`);

  // --- clock
  const chrony = await d.chrony();
  const clockOffsetMs = m.demoOrderTsOffset.length >= 3 ? quantile([...m.demoOrderTsOffset].sort((a, b) => a - b), 0.5)! : (m.polyServerTimeOffsetMs.length >= 3 ? quantile([...m.polyServerTimeOffsetMs].sort((a, b) => a - b), 0.5) : null);
  if (m.demoOrderTsOffset.length >= 3) notes.push("clockOffsetMs = median(Kalshi demo ts_ms - local midpoint); positive = local clock behind Kalshi");
  else if (clockOffsetMs !== null) notes.push("clockOffsetMs from Polymarket GET /time has only 1s resolution: coarse, do not rely on it; run chrony");
  if (!chrony) notes.push("chronyc not available; install chrony and keep offset < 1ms (clock skew of a few ms swamps Polymarket's ~5ms latency)");
  notes.push("feedDelay components are NOT measured by the probe (defaults kept); record market data (RECORD_MD=1) to estimate recv - venueTs");
  notes.push("one-way latency = RTT/2 (symmetry assumption)");
  unverified.push("Kalshi process time derived from demo orders (demo != production)");

  const profile = buildProfile(m, defaultProfile());
  const sm: Record<string, Summary> = {};
  for (const [k, v] of Object.entries(m)) sm[k] = summarize(v as number[]);
  const meta: ProbeMeta = {
    generatedAt: new Date().toISOString(), host: (await Bun.$`hostname`.quiet().text().catch(() => "unknown")).trim(),
    clockOffsetMs, chrony: chrony ? chrony.split("\n").slice(0, 8).join("\n") : null, measurements: sm, notes, unverified, demo,
  };
  const out = writeLatencyJson(opts.out ?? config2.latencyJson, profile, meta);
  log(`[probe] wrote ${opts.out ?? config2.latencyJson}`);
  for (const [k, s] of Object.entries(sm)) if (s.n) log(`  ${k.padEnd(18)} n=${String(s.n).padStart(3)} p50=${s.p50}ms p95=${s.p95}ms p99=${s.p99}ms`);
  for (const u of unverified) log(`  UNVERIFIED: ${u}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ CLI
async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  console.log("[probe] plan: public + (if keys set) signed READ-ONLY calls; Kalshi demo orders if demo keys set; no real-money orders unless CALIBRATE_LIVE=1 AND --live AND typed confirmation.");
  await runProbe({ n: Number(arg("--n")) || 30, out: arg("--out"), demo: !argv.includes("--no-demo") });
  if (argv.includes("--live") || process.env.CALIBRATE_LIVE === "1") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const rep = await runLiveCalibration({ deps: defaultDeps(), argv, ask: (q) => rl.question(q), maxOrders: Number(arg("--live-n")) || 3 });
      if (rep.refused.length) console.log(`[probe] live calibration REFUSED, missing: ${rep.refused.join("; ")}`);
      else console.log(`[probe] live calibration: ${JSON.stringify(rep)}`);
    } finally { rl.close(); }
  }
}
if (import.meta.main) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
