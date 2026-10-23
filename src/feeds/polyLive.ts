// Polymarket live-data v2 websocket (needs CLOB API creds): Chainlink price.crypto.twap (60s TWAP, Polymarket's resolution
// source) + price.crypto. UNTESTED against the real server (no creds in dev); covered by a mock WS server.
// Without creds this feed is never started and the public RTDS Chainlink feed (chainlink.ts) is used unchanged.
import { Series, type SpotQuote } from "./spot.ts";
import { meter } from "./meter.ts";
import { bump } from "./notify.ts";
import { connectWS, type WSHandle } from "./ws.ts";

export interface PolyLiveOpts { url: string; apiKey: string; secret: string; passphrase: string; symbol?: string; windowSeconds?: number }
export const STALE_MS = 5000;
const NAME = "polyLive";
const twap = new Series(2 * 3600_000);
const live = new Series(2 * 3600_000);
let lastTwapLocal = 0, lastTwapVal = NaN, lastLiveVal = NaN;
let authed = false, loggedAuth = false;

function point(s: Series, p: any) {
  const v = Number(p?.value), ts = Number(p?.timestamp);
  if (!(v > 0) || !(ts > 0)) return false;
  s.push(ts, v);
  return true;
}

export function polyLiveStart(o: PolyLiveOpts): WSHandle {
  const symbol = o.symbol ?? "btcusd", win = o.windowSeconds ?? 60;
  const m = meter(NAME);
  return connectWS({
    name: NAME, url: o.url, staleMs: 30_000, pingMs: 20_000, pingMsg: JSON.stringify({ op: "ping" }),
    onOpen: (ws) => { authed = false; ws.send({ op: "auth", rid: "a1", auth: { apiKey: o.apiKey, secret: o.secret, passphrase: o.passphrase } }); },
    onClose: (code) => {
      authed = false;
      if (code === 4001) { if (!loggedAuth) { loggedAuth = true; console.log("[polyLive] auth failed (close 4001); check POLY_API_KEY/SECRET/PASSPHRASE. Not retrying; using public Chainlink feed."); } return "stop"; }
      if (code === 4003) return Math.floor(Math.random() * 10_000);
    },
    onMessage: (raw, ws) => {
      if (raw[0] !== "{") return;
      const j = JSON.parse(raw);
      if (j.op) {
        if (j.op === "authed") {
          authed = true;
          ws.send({ op: "subscribe", rid: "s1", subscriptions: [
            { channel: "price.crypto.twap", filter: { symbol, window_seconds: win } },
            { channel: "price.crypto", filter: { symbol } },
          ] });
        } else if (j.op === "error") {
          if (!loggedAuth) { loggedAuth = true; console.log(`[polyLive] server error: ${String(j.code ?? "unknown")}`); }
        }
        return;
      }
      const p = j.payload;
      const isTwap = j.channel === "price.crypto.twap";
      if (j.snapshot && Array.isArray(p?.data)) { // last ~2 min: seeds the buffers
        const s = isTwap ? twap : live;
        for (const d of p.data) point(s, d);
        if (isTwap && !lastTwapLocal && p.data.length) lastTwapLocal = Date.now();
        return;
      }
      if (!p) return;
      if (p.symbol && p.symbol !== symbol) return;
      const ts = Number(p.timestamp);
      if (ts > 1e12) m.latency(Date.now() - ts);
      if (isTwap) {
        if (!point(twap, p)) return;
        lastTwapLocal = Date.now();
        if (Number(p.value) !== lastTwapVal) { lastTwapVal = Number(p.value); m.change(); bump("spot"); }
      } else if (j.channel === "price.crypto") {
        if (!point(live, p)) return;
        if (Number(p.value) !== lastLiveVal) { lastLiveVal = Number(p.value); bump("spot"); }
      }
    },
  });
}

/** Latest Chainlink 60s TWAP, or null when absent/stale. ts = local receipt time. */
export function twapSpot(now = Date.now()): SpotQuote | null {
  const l = twap.last();
  return l && lastTwapLocal && now - lastTwapLocal <= STALE_MS ? { price: l[1], ts: lastTwapLocal, source: "chainlink-twap" } : null;
}
/** The TWAP value is itself the 60s mean (as of its timestamp), so spotAvg60 is the latest/at-close TWAP. */
export function twapAvg60(closeMs?: number): number | null {
  return closeMs ? twap.at(closeMs, 5000) : twap.last()?.[1] ?? null;
}
/** Spot-price history from price.crypto for the strike fallback (price at/just before a unix-second timestamp). */
export const liveAt = (sec: number) => live.at(sec * 1000, 10_000);
export const polyLiveAuthed = () => authed;
export function polyLiveReset() { twap.clear(); live.clear(); lastTwapLocal = 0; lastTwapVal = NaN; lastLiveVal = NaN; authed = false; loggedAuth = false; }
