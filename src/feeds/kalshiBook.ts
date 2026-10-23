// Kalshi's websocket requires API-key auth (401 without), so the default is fast REST polling of
// GET /markets/{ticker}/orderbook?depth=1 (measured p50 ~66ms). Up ask = 100 - best NO bid, Down ask = 100 - best YES bid.
// (KALSHI_API_KEY_ID/KALSHI_PRIVATE_KEY signed-WS path intentionally NOT implemented: cannot be tested here.)
import { config } from "../config.ts";
import { getJson } from "../http.ts";
import { meter } from "./meter.ts";
import { bump } from "./notify.ts";

export interface KTop { yesBid: number | null; noBid: number | null; ts: number }
const tops = new Map<string, KTop>();
let ticker: string | null = null;
let backoffUntil = 0, backoffMs = 1000;
const m = meter("kalshiBook(rest)");

const best = (lv: unknown) => {
  const px = (Array.isArray(lv) ? lv : []).filter((l: any) => Number(l?.[1]) > 0).map((l: any) => Number(l[0]) * 100).filter(Number.isFinite);
  const v = px.length ? Math.round(Math.max(...px) * 100) / 100 : null;
  return v !== null && v > 0 ? v : null;
};

/** One-shot orderbook fetch (also used as REST fallback). */
export async function fetchKalshiTop(tk: string): Promise<KTop | null> {
  const j = await getJson(`${config.kalshiBase}/markets/${tk}/orderbook?depth=1`, 3000);
  const ob = j?.orderbook_fp ?? j?.orderbook ?? null;
  if (!ob) return null;
  return { yesBid: best(ob.yes_dollars ?? ob.yes), noBid: best(ob.no_dollars ?? ob.no), ts: Date.now() };
}

export const kalshiWatch = (tk: string) => { ticker = tk; };
export const kalshiTop = (tk: string): KTop | null => tops.get(tk) ?? null;

export function startKalshiBook() {
  m.connected = true;
  (async () => {
    for (;;) {
      const t0 = Date.now();
      const tk = ticker;
      try {
        if (tk && t0 >= backoffUntil) {
          const r = await fetchKalshiRaw(tk);
          if (r === 429) { backoffUntil = Date.now() + backoffMs; backoffMs = Math.min(10_000, backoffMs * 2); m.reconnects++; }
          else if (r) {
            backoffMs = 1000; m.hit();
            const prev = tops.get(tk);
            tops.set(tk, r);
            if (!prev || prev.yesBid !== r.yesBid || prev.noBid !== r.noBid) bump("kalshi");
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
    return ob ? { yesBid: best(ob.yes_dollars ?? ob.yes), noBid: best(ob.no_dollars ?? ob.no), ts: Date.now() } : null;
  } catch { return null; }
}
