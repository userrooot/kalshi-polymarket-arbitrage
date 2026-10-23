import { tapRaw } from "../exec/recorderHook.ts";
import { meter } from "./meter.ts";

export interface WSOpts {
  name: string;
  url: string;
  onOpen?: (ws: WSHandle) => void;
  onMessage: (data: string, ws: WSHandle) => void;
  pingMs?: number;
  pingMsg?: string;          // text sent every pingMs (default none)
  staleMs?: number;          // reconnect if no message for this long
  meterName?: string;
  /** Called on EVERY connect attempt (handshake headers, e.g. a fresh signed timestamp). Throwing counts as a failed attempt. */
  headers?: () => Record<string, string>;
  /** Called on every close. Return "stop" to give up for good, or a number (ms) to override the next reconnect delay. */
  onClose?: (code: number, reason: string) => "stop" | number | void;
  maxBackoffMs?: number;     // default 10s
  /** Called when the socket errors (e.g. failed upgrade). A close handler is NOT called afterwards for the same socket. */
  onError?: () => void;
}
export interface WSHandle { send(s: string | object): void; close(): void; reconnect(): void }

/** Auto-reconnecting WebSocket (proxy-aware, backoff 0.5s*2^n capped 10s, stale watchdog). */
export function connectWS(o: WSOpts): WSHandle {
  const m = meter(o.meterName ?? o.name);
  let ws: WebSocket | null = null, closed = false, attempt = 0, lastMsg = Date.now();
  let timers: ReturnType<typeof setInterval>[] = [];
  let retry: ReturnType<typeof setTimeout> | null = null;
  let forcedDelay: number | null = null;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  const handle: WSHandle = {
    send(s) { try { if (ws?.readyState === 1) { const out = typeof s === "string" ? s : JSON.stringify(s); if (out !== "PING") tapRaw(o.name + ">", out); ws.send(out); } } catch {} }, // ">" = outbound (subscriptions), recorded so replay knows the token/ticker mapping
    close() { closed = true; cleanup(); try { ws?.close(); } catch {} },
    reconnect() { try { ws?.close(); } catch {} drop(); },
  };
  const cleanup = () => { for (const t of timers) clearInterval(t); timers = []; if (retry) clearTimeout(retry); retry = null; };
  const drop = () => {
    if (retry) return; // already scheduled (reconnect() + onclose both land here)
    cleanup();
    m.connected = false;
    if (closed) return;
    m.reconnects++;
    const delay = forcedDelay ?? Math.min(o.maxBackoffMs ?? 10_000, 500 * 2 ** attempt++);
    forcedDelay = null;
    retry = setTimeout(() => { retry = null; open(); }, delay);
  };
  function open() {
    if (closed) return;
    let mine: WebSocket;
    try {
      const headers = o.headers?.();
      const local = /^wss?:\/\/(localhost|127\.|\[::1\])/.test(o.url);
      const opts: any = {};
      if (proxy && !local) opts.proxy = proxy;
      if (headers) opts.headers = headers;
      mine = Object.keys(opts).length ? new WebSocket(o.url, opts) : new WebSocket(o.url);
    } catch { drop(); return; }
    ws = mine; lastMsg = Date.now();
    let dead = false;
    const die = () => { if (dead || ws !== mine) return; dead = true; try { mine.close(); } catch {} drop(); };
    mine.onopen = () => {
      m.connected = true; lastMsg = Date.now();
      try { o.onOpen?.(handle); } catch (e) { console.error(`[${o.name}] onOpen`, e); }
      if (o.pingMs && o.pingMsg) timers.push(setInterval(() => handle.send(o.pingMsg!), o.pingMs));
      if (o.staleMs) timers.push(setInterval(() => { if (Date.now() - lastMsg > o.staleMs!) { console.log(`[${o.name}] stale, reconnecting`); die(); } }, Math.min(1000, o.staleMs)));
    };
    mine.onmessage = (e) => {
      if (ws !== mine) return;
      lastMsg = Date.now(); attempt = 0; m.hit();
      const data = typeof e.data === "string" ? e.data : String(e.data);
      tapRaw(o.name, data); // raw-message recorder tap (no-op unless RECORD_MD=1)
      try { o.onMessage(data, handle); } catch (err) { console.error(`[${o.name}] onMessage`, err); }
    };
    mine.onerror = () => { if (!dead && ws === mine) { try { o.onError?.(); } catch (err) { console.error(`[${o.name}] onError`, err); } } die(); };
    mine.onclose = (e: any) => {
      if (ws === mine && !dead && o.onClose) {
        try {
          const r = o.onClose(Number(e?.code) || 0, String(e?.reason ?? ""));
          if (r === "stop") { closed = true; cleanup(); m.connected = false; return; }
          if (typeof r === "number") forcedDelay = r;
        } catch (err) { console.error(`[${o.name}] onClose`, err); }
      }
      die();
    };
  }
  open();
  return handle;
}
