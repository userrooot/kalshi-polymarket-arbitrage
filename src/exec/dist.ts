// Small numeric helpers shared by the exec layer (pure).
import type { Dist } from "./types.ts";

/** Linear-interpolated percentile of an ASCENDING-sorted array (q in 0..1). */
export function pct(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const r2 = (n: number | null) => (n === null ? null : Math.round(n * 100) / 100);

export function dist(values: number[]): Dist {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, p50: null, p95: null, p99: null, mean: null };
  return { n: v.length, p50: r2(pct(v, 0.5)), p95: r2(pct(v, 0.95)), p99: r2(pct(v, 0.99)), mean: r2(v.reduce((a, b) => a + b, 0) / v.length) };
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
