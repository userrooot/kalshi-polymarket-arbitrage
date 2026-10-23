import { connectWS } from "./ws.ts";
import { Series, type SpotQuote } from "./spot.ts";
import { bump } from "./notify.ts";
import { liveAt } from "./polyLive.ts";
import { meter } from "./meter.ts";

const series = new Series(2 * 3600_000);
let lastLocal = 0, lastVal = NaN;

export function startChainlink() {
  connectWS({
    name: "chainlink", url: "wss://ws-live-data.polymarket.com",
    pingMs: 5000, pingMsg: "PING", staleMs: 5000,
    onOpen: (ws) => ws.send({ action: "subscribe", subscriptions: [{ topic: "crypto_prices_chainlink", type: "*", filters: JSON.stringify({ symbol: "btc/usd" }) }] }),
    onMessage: (raw) => {
      if (raw === "PONG" || raw[0] !== "{") return;
      const j = JSON.parse(raw);
      const p = j?.payload;
      if (j.topic === "crypto_prices_chainlink" && j.type === "update" && p?.symbol === "btc/usd" && Number(p.value) > 0) {
        series.push(Number(p.timestamp), Number(p.value)); lastLocal = Date.now(); bump("spot");
        if (Number(p.value) !== lastVal) { lastVal = Number(p.value); meter("chainlink").change(); }
      } else if (Array.isArray(p?.data)) {
        for (const d of p.data) if (Number(d?.value) > 0) series.push(Number(d.timestamp), Number(d.value));
        if (!lastLocal) lastLocal = Date.now();
      }
    },
  });
}

/** Latest Chainlink BTC/USD (Polymarket's resolution source). ts = local receipt time. */
export function chainlinkSpot(): SpotQuote | null {
  const l = series.last();
  return l && lastLocal ? { price: l[1], ts: lastLocal, source: "chainlink" } : null;
}
/** Chainlink price at/just before a unix-second timestamp (Polymarket strike fallback). */
export const chainlinkAt = (sec: number) => series.at(sec * 1000, 10_000) ?? liveAt(sec);
/** Mean of the last 60s of Chainlink data (or of [closeMs-60s, closeMs] when closeMs is given). */
export const chainlinkAvg60 = (closeMs?: number) => closeMs ? series.mean(closeMs - 60_000, closeMs) : series.mean((series.last()?.[0] ?? 0) - 60_000, Infinity);
