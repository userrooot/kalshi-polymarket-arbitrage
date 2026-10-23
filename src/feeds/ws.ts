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
}
export interface WSHandle { send(s: string | object): void; close(): void; reconnect(): void }

/** Auto-reconnecting WebSocket (proxy-aware, backoff 0.5s*2^n capped 10s, stale watchdog). */
export function connectWS(o: WSOpts): WSHandle {
  const m = meter(o.meterName ?? o.name);
  let ws: WebSocket | null = null, closed = false, attempt = 0, lastMsg = Date.now();
  let timers: ReturnType<typeof setInterval>[] = [];
  let retry: ReturnType<typeof setTimeout> | null = null;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

  const handle: WSHandle = {
    send(s) { try { if (ws?.readyState === 1) ws.send(typeof s === "string" ? s : JSON.stringify(s)); } catch {} },
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
    const delay = Math.min(10_000, 500 * 2 ** attempt++);
    retry = setTimeout(open, delay);
  };
  function open() {
    if (closed) return;
    let mine: WebSocket;
    try { mine = proxy ? new WebSocket(o.url, { proxy } as any) : new WebSocket(o.url); } catch { drop(); return; }
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
      try { o.onMessage(typeof e.data === "string" ? e.data : String(e.data), handle); } catch (err) { console.error(`[${o.name}] onMessage`, err); }
    };
    mine.onerror = () => die();
    mine.onclose = () => die();
  }
  open();
  return handle;
}
