import { getJson } from "./http.ts";

let last: number | null = null;
const windowStart = new Map<number, number>(); // window start (unix s) -> first BTC price seen near start

export const btcPrice = () => last;
/** BTC price recorded by our own feed within 30s of the window start (strike fallback for Polymarket). */
export const btcAtWindowStart = (startSec: number) => windowStart.get(startSec) ?? null;

export async function pollBtc(now = Date.now()) {
  const a = await getJson<any>("https://api.coinbase.com/v2/prices/BTC-USD/spot", 3000);
  let p = Number(a?.data?.amount);
  if (!(p > 0)) {
    const b = await getJson<any>("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", 3000);
    p = Number(b?.price);
  }
  if (!(p > 0)) return;
  last = p;
  const start = Math.floor(now / 900_000) * 900;
  if (!windowStart.has(start) && now - start * 1000 < 30_000) {
    windowStart.set(start, p);
    for (const k of windowStart.keys()) if (k < start - 7200) windowStart.delete(k);
  }
}
