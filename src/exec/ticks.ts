// Price grids (cents). Kalshi markets have tapered price_ranges; Polymarket has one tick_size per market.
export type TickFn = (price: number) => number;
export interface PriceRange { start: number; end: number; step: number } // cents

const EPS = 1e-9;
/** Kalshi default taper: 0.1c steps below 10c and above 90c, 1c in between (used when the market lists no price_ranges). */
export const defaultKalshiTick: TickFn = (p) => (p < 10 || p > 90 ? 0.1 : 1);

/** Parse Kalshi `price_ranges` ([{start:"0.0000",end:"0.1000",step:"0.0010"}], dollars) into cents. Undefined if unusable. */
export function parseKalshiRanges(raw: unknown): PriceRange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PriceRange[] = [];
  for (const r of raw) {
    const s = Number((r as any)?.start) * 100, e = Number((r as any)?.end) * 100, st = Number((r as any)?.step) * 100;
    if (Number.isFinite(s) && Number.isFinite(e) && Number.isFinite(st) && st > 0 && e > s) out.push({ start: s, end: e, step: st });
  }
  return out.length ? out : undefined;
}
export function kalshiTickFn(ranges?: PriceRange[]): TickFn {
  if (!ranges?.length) return defaultKalshiTick;
  return (p) => { for (const r of ranges) if (p >= r.start - EPS && p < r.end - EPS) return r.step; return defaultKalshiTick(p); };
}
export const polyTickFn = (tickSizeDollars = 0.01): TickFn => { const t = tickSizeDollars * 100; return () => t; };

const clean = (x: number) => Math.round(x * 1e6) / 1e6;
/** Round to the grid: dir "up" (buy limits), "down" (sell limits) or nearest. */
export function roundToTick(price: number, tick: TickFn, dir: "up" | "down" | "nearest" = "nearest"): number {
  const step = tick(dir === "up" ? price - EPS : price + (dir === "down" ? EPS : 0));
  const q = price / step;
  const n = dir === "up" ? Math.ceil(q - 1e-7) : dir === "down" ? Math.floor(q + 1e-7) : Math.round(q);
  return clean(n * step);
}
/** Move `n` grid steps (n may be 0 or negative) from an on-grid price, each step using the tick at the current price. */
export function addTicks(price: number, n: number, tick: TickFn): number {
  let p = price;
  for (let i = 0; i < n; i++) p = clean(p + tick(p + EPS));
  for (let i = 0; i > n; i--) p = clean(p - tick(p - EPS));
  return p;
}
