// CF Benchmarks BRTI index pushed over the authenticated Kalshi websocket (channel cfbenchmarks_value_5hz).
// This IS Kalshi's resolution index (spotSource "cfbenchmarks"). brti.ts (exchange-median proxy) is the automatic fallback
// whenever this feed is absent, stale (> STALE_MS) or its subscription was rejected.
import { Series, type SpotQuote } from "./spot.ts";
import { meter } from "./meter.ts";
import { bump } from "./notify.ts";

export const STALE_MS = 3000;
const series = new Series(30 * 60_000);
let lastLocal = 0, lastValue = NaN, unavailable = false, loggedUnavailable = false;
const m = () => meter("kalshiIndex(cf)");

/** msg shape: {type:"cfbenchmarks_value_5hz", msg:{index_id, value_usd, source_ts_ms, received_at}} */
export function cfOnMessage(j: any, indexId = "BRTI") {
  const d = j?.msg;
  if (!d || (d.index_id && d.index_id !== indexId)) return;
  const v = Number(d.value_usd);
  if (!(v > 0)) return;
  const ts = Number(d.source_ts_ms) > 1e12 ? Number(d.source_ts_ms) : Date.now();
  series.push(ts, v);
  lastLocal = Date.now();
  unavailable = false;
  const mm = m(); mm.hit();
  if (v !== lastValue) { lastValue = v; mm.change(); bump("spot"); }
}

/** Mark the channel unusable (subscribe rejected); logs once, spot falls back to the exchange-median proxy. */
export function cfMarkUnavailable(reason: string) {
  unavailable = true;
  if (!loggedUnavailable) { loggedUnavailable = true; console.log(`[kalshiIndex] cfbenchmarks channel unavailable (${reason}); using brti-proxy fallback`); }
}
export const cfConnected = (v: boolean) => { m().connected = v; };

/** Latest CF Benchmarks value, or null when absent/stale/unavailable. ts = local receipt time. */
export function cfSpot(now = Date.now()): SpotQuote | null {
  const l = series.last();
  if (!l || unavailable || !lastLocal || now - lastLocal > STALE_MS) return null;
  return { price: l[1], ts: lastLocal, source: "cfbenchmarks" };
}
/** Mean of the real index over the last 60s, or over [closeMs-60s, closeMs-1s] (Kalshi's settlement window). */
export function cfAvg60(closeMs?: number): number | null {
  if (closeMs) return series.mean(closeMs - 60_000, closeMs - 1000);
  const l = series.last();
  return l ? series.mean(l[0] - 60_000, Infinity) : null;
}
/** test helper */
export function cfReset() { series.clear(); lastLocal = 0; lastValue = NaN; unavailable = false; }
