// Kalshi Up/Down quotes. With KALSHI_API_KEY_ID + a private key the authenticated websocket (kalshiWs.ts) is the primary source
// (quoteSource "ws"); REST polling of GET /markets/{ticker}/orderbook?depth=1 (p50 ~66ms) runs only while the WS is down / not
// snapshotted / the quote is older than MAX_QUOTE_AGE_MS. Without keys it is REST only, and quotes honestly report "rest".
// Up ask = 100 - best NO bid, Down ask = 100 - best YES bid.
import { setAlert } from "../alerts.ts";
import { config } from "../config.ts";
import { getJson } from "../http.ts";
import { loadPrivateKey } from "./kalshiAuth.ts";
import { kalshiWsReady, kalshiWsStart, kalshiWsWatch, type KalshiWsOpts } from "./kalshiWs.ts";
import { meter } from "./meter.ts";
import { bump } from "./notify.ts";
import { publishKalshi } from "../exec/hub.ts";

export interface KTop { yesBid: number | null; noBid: number | null; ts: number; src: "ws" | "rest"; yesSz?: number; noSz?: number }
const tops = new Map<string, KTop>();
let ticker: string | null = null;
let backoffUntil = 0, backoffMs = 1000;
let wsOn = false;
const rm = () => meter("kalshiBook(rest)"); // created lazily so it does not show as an idle feed when the WS is primary

const bestLvl = (lv: unknown): { price: number; size: number } | null => {
  let b: { price: number; size: number } | null = null;
  for (const l of Array.isArray(lv) ? lv : []) {
    const p = Number((l as any)?.[0]) * 100, sz = Number((l as any)?.[1]);
    if (Number.isFinite(p) && sz > 0 && p > 0 && (!b || p > b.price)) b = { price: Math.round(p * 100) / 100, size: sz };
  }
  return b;
};
const best = (lv: unknown) => bestLvl(lv)?.price ?? null;
const restTop = (ob: any): KTop => {
  const y = bestLvl(ob.yes_dollars ?? ob.yes), n = bestLvl(ob.no_dollars ?? ob.no);
  return { yesBid: y?.price ?? null, noBid: n?.price ?? null, ts: Date.now(), src: "rest", yesSz: y?.size, noSz: n?.size };
};

/** One-shot orderbook fetch (also used as REST fallback). */
export async function fetchKalshiTop(tk: string): Promise<KTop | null> {
  const j = await getJson(`${config.kalshiBase}/markets/${tk}/orderbook?depth=1`, 3000);
  const ob = j?.orderbook_fp ?? j?.orderbook ?? null;
  if (!ob) return null;
  return restTop(ob);
}

export const kalshiWatch = (tk: string) => { ticker = tk; if (wsOn) kalshiWsWatch(tk); };
export const kalshiTop = (tk: string): KTop | null => tops.get(tk) ?? null;
export const kalshiWsEnabled = () => wsOn;

function store(tk: string, r: KTop, meterName: "ws" | "rest") {
  const prev = tops.get(tk);
  // COARSE depth: only the best level of each side (REST ?depth=1); WS depth is published from kalshiWs.ts. While the WS book is
  // live a quiet market (no delta for MAX_QUOTE_AGE_MS) still triggers REST polls: do NOT interleave those top-1 books with the
  // full WS ladder in the exec history (deeper levels would flap away -> fake depth_consumed kills, fake race losses).
  if (r.src === "rest" && !(wsOn && kalshiWsReady(tk)))
    publishKalshi(tk, r.yesBid !== null ? [{ price: r.yesBid, size: r.yesSz ?? 1 }] : [], r.noBid !== null ? [{ price: r.noBid, size: r.noSz ?? 1 }] : [], null, "rest-coarse");
  tops.set(tk, r);
  if (!prev || prev.yesBid !== r.yesBid || prev.noBid !== r.noBid) {
    meter(meterName === "ws" ? "kalshiBook(ws)" : "kalshiBook(rest)").change();
    bump("kalshi");
  }
}

let authError: string | null = null;
/** Why the official Kalshi feed cannot even start (no key id / unreadable key), or null. */
export const kalshiAuthError = () => authError;
const noAuth = (why: string) => {
  authError = why;
  setAlert("kalshi-auth", `Kalshi official BRTI spot disabled: ${why}. Add KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY) to .env.`);
  console.log(`[kalshiBook] ${why}; Kalshi spot will be null (no substitute price is used), quotes via REST`);
  return false;
};

/** Try to enable the signed WS. Returns false (and logs once, never the key) when keys are missing/unreadable. */
function tryStartWs(over?: Partial<KalshiWsOpts>): boolean {
  authError = null;
  const keyId = over?.keyId ?? config.kalshiApiKeyId;
  console.log(`[kalshiBook] KALSHI_API_KEY_ID ${keyId ? "set" : "NOT set"}; key source: ${over?.privateKey ? "provided" : config.kalshiPrivateKey ? "inline PEM" : config.kalshiPrivateKeyPath ? `file ${config.kalshiPrivateKeyPath}` : "none"}`);
  if (!keyId) return noAuth("KALSHI_API_KEY_ID not set");
  let key = over?.privateKey ?? null;
  if (!key) {
    try { key = loadPrivateKey({ pem: config.kalshiPrivateKey, path: config.kalshiPrivateKeyPath }); }
    catch (e) { return noAuth(`cannot read/parse Kalshi private key (${(e as Error).message.split("\n")[0]})`); }
  }
  if (!key) return noAuth("no Kalshi private key (set KALSHI_PRIVATE_KEY_PATH or KALSHI_PRIVATE_KEY)");
  console.log(`[kalshiBook] private key found and parsed; asymmetricKeyType=${key.asymmetricKeyType}`);
  kalshiWsStart({ url: config.kalshiWsUrl, ...over, keyId, privateKey: key, onTop: (tk, t) => store(tk, { ...t, ts: Date.now(), src: "ws" }, "ws") });
  return true;
}

export function startKalshiBook(over?: Partial<KalshiWsOpts>) {
  wsOn = tryStartWs(over);
  if (wsOn) { console.log("[kalshiBook] authenticated websocket enabled (REST polling only as fallback)"); if (ticker) kalshiWsWatch(ticker); }
  else rm().connected = true;
  (async () => {
    for (;;) {
      const t0 = Date.now();
      const tk = ticker;
      try {
        const wsFresh = wsOn && tk !== null && kalshiWsReady(tk) && (tops.get(tk)?.src === "ws") && t0 - (tops.get(tk)?.ts ?? 0) <= config.maxQuoteAgeMs;
        if (tk && t0 >= backoffUntil && !wsFresh) {
          const r = await fetchKalshiRaw(tk);
          if (r === 429) { backoffUntil = Date.now() + backoffMs; backoffMs = Math.min(10_000, backoffMs * 2); rm().reconnects++; }
          else if (r) {
            backoffMs = 1000; rm().hit();
            // never let a REST read clobber a fresher WS top
            const cur = tops.get(tk);
            if (!(wsOn && cur?.src === "ws" && cur.ts >= r.ts - 50 && kalshiWsReady(tk))) store(tk, r, "rest");
          }
        }
      } catch {}
      await Bun.sleep(Math.max(20, config.kalshiBookPollMs - (Date.now() - t0)));
    }
  })();
}

async function fetchKalshiRaw(tk: string): Promise<KTop | 429 | null> {
  try {
    const r = await fetch(`${config.kalshiBase}/markets/${tk}/orderbook?depth=1`, { signal: AbortSignal.timeout(3000), headers: { accept: "application/json" } });
    if (r.status === 429) return 429;
    if (!r.ok) return null;
    const j: any = await r.json();
    const ob = j?.orderbook_fp ?? j?.orderbook;
    return ob ? restTop(ob) : null;
  } catch { return null; }
}
