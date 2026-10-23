// Authenticated Kalshi websocket: orderbook_delta book + official CF Benchmarks BRTI (cfbenchmarks_value + _5hz) on ONE connection.
// UNTESTED against the real server (no keys in dev); covered by unit tests + a mock WS server.
import type { KeyObject } from "node:crypto";
import { kalshiHeaders } from "./kalshiAuth.ts";
import { KalshiBook, SeqTracker } from "./kalshiOrderbook.ts";
import { clearAlert, setAlert } from "../alerts.ts";
import { cfConnected, cfMarkUnavailable, cfOnMessage, cfSetError } from "./kalshiIndex.ts";
import { meter } from "./meter.ts";
import { connectWS, type WSHandle } from "./ws.ts";

export interface KalshiWsOpts {
  url: string;
  keyId: string;
  privateKey: KeyObject;
  /** send use_yes_price=true (default) => NO levels arrive on the YES price scale; the book builder uses the same flag. */
  useYesPrice?: boolean;
  indexId?: string;            // default "BRTI"
  onTop: (ticker: string, top: { yesBid: number | null; noBid: number | null }) => void;
  snapshotRetryMs?: number;    // default 3000
}

const NAME = "kalshiBook(ws)";
let o: KalshiWsOpts | null = null;
let handle: WSHandle | null = null;
let up = false;
let watched: string | null = null;
const books = new Map<string, KalshiBook>();
const seq = new SeqTracker();
let nextId = 1;
const pending = new Map<number, "ob" | "cf" | "upd" | "idx">();
const CF_CHANNELS = ["cfbenchmarks_value", "cfbenchmarks_value_5hz"];
let cfSid: number | null = null, indexListAsked = false;
let lastDiag = 0;
let obSid: number | null = null, obPending = false, cfPending = false;
const subscribed = new Set<string>();
let lastSnapReq = 0, snapAttempts = 0;
let loggedFail = false;
const loggedCodes = new Set<number>();

const send = (cmd: string, params: object, kind: "ob" | "cf" | "upd" | "idx") => {
  const id = nextId++;
  pending.set(id, kind);
  handle?.send({ id, cmd, params });
};
const log = (s: string) => console.log(`[kalshiWs] ${s}`);

export function kalshiWsStart(opts: KalshiWsOpts): WSHandle {
  o = opts;
  const path = new URL(opts.url).pathname;
  handle = connectWS({
    name: NAME, url: opts.url, staleMs: 60_000, maxBackoffMs: 30_000,
    headers: () => kalshiHeaders(opts.keyId, opts.privateKey, path), // fresh signed timestamp per connect
    onOpen: () => {
      up = true; books.clear(); seq.clear(); pending.clear(); subscribed.clear();
      obSid = null; obPending = false; cfPending = false; snapAttempts = 0; lastSnapReq = 0; loggedFail = false;
      cfSid = null; indexListAsked = false;
      reconcile();
      cfPending = true; send("subscribe", { channels: CF_CHANNELS, index_ids: [opts.indexId ?? "BRTI"] }, "cf");
    },
    onClose: (code) => down(`connection closed (code ${code || "n/a"})`),
    onError: () => down("connection error"),
    onMessage: (raw) => { if (raw[0] === "{") onMsg(JSON.parse(raw)); },
  });
  setInterval(snapshotWatchdog, 1000).unref?.();
  return handle;
}

/** Stop everything (tests). */
export function kalshiWsStop() { handle?.close(); handle = null; up = false; o = null; books.clear(); watched = null; }

/** Set the single ticker we want the book for (current window). Rollover adds the new market and drops the old one. */
export function kalshiWsWatch(tk: string) {
  if (watched === tk) return;
  watched = tk;
  reconcile();
}

/** True when the WS book for tk is connected and snapshotted (REST fallback not needed). */
export const kalshiWsReady = (tk: string) => up && books.get(tk)?.snapshotted === true;
export const kalshiWsUp = () => up;

function reconcile() {
  if (!up || !o || !watched) return;
  if (obSid === null) {
    if (obPending) return;
    obPending = true;
    subscribed.add(watched);
    send("subscribe", { channels: ["orderbook_delta"], market_tickers: [watched], use_yes_price: o.useYesPrice ?? true }, "ob");
    return;
  }
  if (!subscribed.has(watched)) {
    subscribed.add(watched);
    send("update_subscription", { sid: obSid, market_tickers: [watched], action: "add_markets" }, "upd");
  }
  for (const t of [...subscribed]) if (t !== watched) {
    subscribed.delete(t); books.delete(t);
    send("update_subscription", { sid: obSid, market_tickers: [t], action: "delete_markets" }, "upd");
  }
}

function requestSnapshot(why: string) {
  if (!up || obSid === null || !watched) return;
  const now = Date.now();
  if (now - lastSnapReq < (o?.snapshotRetryMs ?? 3000) / 2) return;
  lastSnapReq = now; snapAttempts++;
  for (const b of books.values()) b.reset();
  if (snapAttempts > 3) { log(`no snapshot after ${snapAttempts - 1} requests (${why}); reconnecting`); snapAttempts = 0; handle?.reconnect(); return; }
  send("update_subscription", { sid: obSid, market_tickers: [watched], action: "get_snapshot" }, "upd");
}
function snapshotWatchdog() {
  if (!up || obSid === null || !watched) return;
  if (books.get(watched)?.snapshotted) return;
  if (Date.now() - lastSnapReq >= (o?.snapshotRetryMs ?? 3000)) requestSnapshot("snapshot missing");
}

/** Socket went away (closed or errored). If it never opened, find out WHY via a one-shot signed HTTP request. */
function down(what: string) {
  const wasUp = up;
  up = false; obSid = null; cfSid = null; cfConnected(false);
  for (const b of books.values()) b.reset();
  const reason = wasUp ? `${what} after being connected` : `${what} before the websocket opened (handshake failed)`;
  cfSetError(`Kalshi WS down: ${reason}`);
  if (!loggedFail) { loggedFail = true; log(`${reason}; will retry with backoff. If this repeats, check KALSHI_API_KEY_ID / key / KALSHI_WS_URL. REST book fallback active; no spot without the official feed.`); }
  if (!wasUp) void diagnoseHandshake();
}

/** Bun's WebSocket error event hides the HTTP status/body, so replay the upgrade URL as a plain signed GET (max once / 60s). */
export async function diagnoseHandshake(force = false): Promise<string | null> {
  if (!o || (!force && Date.now() - lastDiag < 60_000)) return null;
  lastDiag = Date.now();
  const url = o.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  let msg: string;
  try {
    const r = await fetch(url, { headers: kalshiHeaders(o.keyId, o.privateKey, new URL(o.url).pathname), signal: AbortSignal.timeout(5000) });
    const text = (await r.text()).slice(0, 300);
    let code = "";
    try { const j = JSON.parse(text); code = String(j?.error?.code ?? j?.code ?? j?.error ?? j?.message ?? ""); } catch { code = text.replace(/\s+/g, " ").trim(); }
    msg = `Kalshi WS handshake failed: HTTP ${r.status}${code ? ` ${code.slice(0, 120)}` : ""}`;
  } catch (e) { msg = `Kalshi WS unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`; }
  log(msg);
  setAlert("kalshi-ws", `${msg} - official BRTI spot unavailable (check KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY_PATH / system clock)`);
  cfSetError(msg);
  return msg;
}

function publish(tk: string, b: KalshiBook) { o?.onTop(tk, b.top()); }

function onMsg(j: any) {
  const t = j?.type;
  const mt = meter(NAME);
  if (t === "orderbook_snapshot" || t === "orderbook_delta") {
    const tk = j.msg?.market_ticker as string | undefined;
    const sid = Number(j.sid), sq = Number(j.seq);
    const st = Number(j.sending_ts_ms);
    if (st > 1e12) mt.latency(Date.now() - st);
    if (t === "orderbook_snapshot") {
      seq.rebase(sid, sq);
      if (!tk || tk !== watched) return;
      let b = books.get(tk);
      if (!b) books.set(tk, (b = new KalshiBook(o?.useYesPrice ?? true)));
      b.snapshot(j.msg); snapAttempts = 0;
      publish(tk, b);
      return;
    }
    const r = seq.check(sid, sq);
    if (r === "gap") { for (const b of books.values()) b.reset(); requestSnapshot(`seq gap at ${sq}`); return; }
    if (!tk || tk !== watched) return;
    const b = books.get(tk);
    if (!b || !b.snapshotted) return;
    b.delta(j.msg);
    publish(tk, b);
  } else if (t === "cfbenchmarks_value_5hz" || t === "cfbenchmarks_value") {
    cfOnMessage(j, o?.indexId ?? "BRTI");
  } else if (t === "subscribed") {
    const ch = j.msg?.channel, sid = Number(j.msg?.sid);
    if (ch === "orderbook_delta") { obSid = sid; obPending = false; clearAlert("kalshi-ws"); reconcile(); }
    else if (CF_CHANNELS.includes(ch)) {
      cfPending = false; cfConnected(true); clearAlert("kalshi-ws"); cfSetError(null);
      if (cfSid === null) cfSid = sid;
      if (!indexListAsked && cfSid !== null) { indexListAsked = true; send("update_subscription", { sid: cfSid, action: "indexlist" }, "idx"); }
    }
  } else if (pending.get(Number(j.id)) === "idx" && t !== "error") {
    checkIndexList(j.msg ?? j);
  } else if (t === "error") {
    const code = Number(j.msg?.code), kind = pending.get(Number(j.id)) ?? (cfPending && j.id === undefined ? "cf" : undefined);
    if (kind === "idx") { log(`indexlist request rejected (code ${code}); cannot verify BRTI exists`); return; }
    if (kind === "cf") {
      cfPending = false;
      const why = code === 24 ? "error 24: index_ids required for cfbenchmarks channels" : `subscribe rejected: error ${code} ${String(j.msg?.msg ?? "").slice(0, 80)}`;
      cfMarkUnavailable(why);
      setAlert("kalshi-ws", `Kalshi official BRTI feed unavailable (${why})`);
      return;
    }
    if (kind === "ob") obPending = false;
    if (code === 25) { requestSnapshot("buffer overflow (25)"); }
    if (!loggedCodes.has(code)) { loggedCodes.add(code); log(`server error code ${code}${code === 9 ? " (auth rejected)" : code === 27 ? " (rate limited)" : ""}: ${String(j.msg?.msg ?? "").slice(0, 120)}`); }
    if (code === 9) handle?.reconnect();
  }
}

/** Defensive: the indexlist reply shape is undocumented; collect any string ids / {index_id|id|name} objects found in arrays. */
function checkIndexList(msg: any) {
  const ids: string[] = [];
  const walk = (x: any, d = 0) => {
    if (d > 3 || x == null) return;
    if (typeof x === "string") ids.push(x);
    else if (Array.isArray(x)) x.forEach((y) => walk(y, d + 1));
    else if (typeof x === "object") { for (const k of ["index_id", "id", "name"]) if (typeof x[k] === "string") ids.push(x[k]); for (const v of Object.values(x)) if (typeof v === "object") walk(v, d + 1); }
  };
  walk(msg);
  const want = o?.indexId ?? "BRTI";
  if (!ids.length) return; // unrecognised shape: do not assume anything
  if (!ids.some((i) => i.toUpperCase() === want)) {
    const why = `index ${want} not in Kalshi indexlist (${ids.slice(0, 8).join(",")})`;
    cfMarkUnavailable(why);
    setAlert("kalshi-ws", `Kalshi official BRTI feed unavailable: ${why}`);
  }
}
