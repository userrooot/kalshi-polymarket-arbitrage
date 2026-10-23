// CF Benchmarks BRTI index pushed over the authenticated Kalshi websocket. This IS Kalshi's resolution index.
// Channels: cfbenchmarks_value_5hz (spot ticks, value_usd) and cfbenchmarks_value (~1Hz; avg_60s_data + last_60s_windowed_average_15min).
// There is NO other price source: when nothing official is fresh every getter returns null and cfError() says why.
import { meter } from "./meter.ts";
import { bump } from "./notify.ts";

export const STALE_MS = 3000;       // max age of a tick to be shown as spot
export const STALE_AVG_MS = 5000;   // max age of the 1Hz message to show avg60 / settlement value
interface Tick { price: number; ts: number }
let t5: Tick | null = null;                       // latest 5hz tick (ts = local receipt)
let t1: Tick | null = null;                       // latest tick derived from the 1Hz message's data field
let avg: { value: number; ts: number } | null = null;
let settle: { value: number; ts: number } | null = null;
let unavailable: string | null = null, err: string | null = null, lastValue = NaN;
const m = () => meter("kalshiIndex(cf)");

const pos = (x: unknown) => { const v = Number(x); return v > 0 && Number.isFinite(v) ? v : null; };
const tsOf = (x: unknown) => (Number(x) > 1e12 ? Number(x) : Date.now());
function parseData(d: unknown): any { if (typeof d === "string") { try { return JSON.parse(d); } catch { return null; } } return d && typeof d === "object" ? d : null; }
/** Defensive: the raw CF frame shape is undocumented, so just look for a value-like field. */
const valueOf = (o: any): number | null => (o ? pos(o.value) ?? pos(o.value_usd) ?? pos(o.price) : null);

/** Handles {type:"cfbenchmarks_value_5hz"} and {type:"cfbenchmarks_value"} messages. */
export function cfOnMessage(j: any, indexId = "BRTI") {
  const d = j?.msg;
  if (!d || (d.index_id && d.index_id !== indexId)) return;
  const now = Date.now();
  let touched = false;
  if (j.type === "cfbenchmarks_value_5hz") {
    const v = pos(d.value_usd) ?? valueOf(parseData(d.data));
    if (v === null) return;
    t5 = { price: v, ts: now }; touched = true;
  } else {
    const v = valueOf(parseData(d.data)) ?? pos(d.value_usd);
    if (v !== null) { t1 = { price: v, ts: now }; touched = true; }
    const a = pos(d.avg_60s_data?.value);
    if (a !== null) { avg = { value: a, ts: now }; touched = true; }
    const s = pos(d.last_60s_windowed_average_15min?.value);
    settle = s !== null ? { value: s, ts: now } : null; // present only in the current window's final minute
    if (s !== null) touched = true;
  }
  if (!touched) return;
  unavailable = null; err = null;
  const mm = m(); mm.hit();
  const cur = cfSpot(now)?.price ?? avg?.value ?? NaN;
  if (cur !== lastValue) { lastValue = cur; mm.change(); bump("spot"); }
}

/** Mark the channel unusable (subscribe rejected, BRTI missing); logs once per distinct reason. */
let loggedReason: string | null = null;
export function cfMarkUnavailable(reason: string) {
  unavailable = reason;
  if (loggedReason !== reason) { loggedReason = reason; console.log(`[kalshiIndex] official BRTI feed unavailable: ${reason}`); }
}
/** Record why the official feed is missing (handshake failure, ws down...) without blocking a later successful message. */
export const cfSetError = (reason: string | null) => { err = reason; };
export const cfConnected = (v: boolean) => { m().connected = v; };

/** Why the official feed has no value right now, or null if it is fine. */
export const cfError = (): string | null => unavailable ?? err;

/** Latest BRTI tick (5hz preferred, else the 1Hz tick), or null when absent/stale/unavailable. ts = local receipt. */
export function cfSpot(now = Date.now()): { price: number; ts: number; source: "cfbenchmarks" } | null {
  if (unavailable) return null;
  const c = [t5, t1].find((x): x is Tick => !!x && now - x.ts <= STALE_MS); // 5hz preferred, 1Hz tick only if 5hz is absent/stale
  return c ? { price: c.price, ts: c.ts, source: "cfbenchmarks" } : null;
}
/** Kalshi-provided trailing-60s average (avg_60s_data.value) from the latest 1Hz message. */
export const cfAvg60 = (now = Date.now()): number | null => (!unavailable && avg && now - avg.ts <= STALE_AVG_MS ? avg.value : null);
/** Kalshi's exact settlement value (last_60s_windowed_average_15min), final minute of the window only. */
export const cfSettle = (now = Date.now()): number | null => (!unavailable && settle && now - settle.ts <= STALE_AVG_MS ? settle.value : null);
/** test helper */
export function cfReset() { t5 = t1 = null; avg = settle = null; unavailable = err = null; loggedReason = null; lastValue = NaN; }
