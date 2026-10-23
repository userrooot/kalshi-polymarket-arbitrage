// Authenticated Kalshi websocket: orderbook_delta book (+ cfbenchmarks_value_5hz index) on ONE connection.
// UNTESTED against the real server (no keys in dev); covered by unit tests + a mock WS server.
import type { KeyObject } from "node:crypto";
import { kalshiHeaders } from "./kalshiAuth.ts";
import { KalshiBook, SeqTracker } from "./kalshiOrderbook.ts";
import { cfConnected, cfMarkUnavailable, cfOnMessage } from "./kalshiIndex.ts";
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
const pending = new Map<number, "ob" | "cf" | "upd">();
let obSid: number | null = null, obPending = false, cfPending = false;
const subscribed = new Set<string>();
let lastSnapReq = 0, snapAttempts = 0;
let loggedFail = false;
const loggedCodes = new Set<number>();

const send = (cmd: string, params: object, kind: "ob" | "cf" | "upd") => {
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
      reconcile();
      cfPending = true; send("subscribe", { channels: ["cfbenchmarks_value_5hz"], index_ids: [opts.indexId ?? "BRTI"] }, "cf");
    },
    onClose: (code) => {
      up = false; obSid = null; cfConnected(false);
      for (const b of books.values()) b.reset();
      if (!loggedFail) { loggedFail = true; log(`connection closed (code ${code || "n/a"}); will retry with backoff. If this repeats, check KALSHI_API_KEY_ID / key / KALSHI_WS_URL. REST fallback active.`); }
    },
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
  } else if (t === "cfbenchmarks_value_5hz") {
    cfOnMessage(j, o?.indexId ?? "BRTI");
  } else if (t === "subscribed") {
    const ch = j.msg?.channel, sid = Number(j.msg?.sid);
    if (ch === "orderbook_delta") { obSid = sid; obPending = false; reconcile(); }
    else if (ch === "cfbenchmarks_value_5hz") { cfPending = false; cfConnected(true); }
  } else if (t === "error") {
    const code = Number(j.msg?.code), kind = pending.get(Number(j.id)) ?? (cfPending && j.id === undefined ? "cf" : undefined);
    if (kind === "cf") { cfPending = false; cfMarkUnavailable(`error ${code}`); return; }
    if (kind === "ob") obPending = false;
    if (code === 25) { requestSnapshot("buffer overflow (25)"); }
    if (!loggedCodes.has(code)) { loggedCodes.add(code); log(`server error code ${code}${code === 9 ? " (auth rejected)" : code === 27 ? " (rate limited)" : ""}: ${String(j.msg?.msg ?? "").slice(0, 120)}`); }
    if (code === 9) handle?.reconnect();
  }
}
