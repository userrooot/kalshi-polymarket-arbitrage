export interface SpotQuote { price: number; ts: number; source: "chainlink" | "chainlink-twap" | "cfbenchmarks" }

/** Time-ordered ring buffer of (ts ms, value) with window means. */
export class Series {
  private pts: [number, number][] = [];
  constructor(private keepMs: number) {}
  push(ts: number, v: number) {
    const a = this.pts;
    if (a.length && ts < a[a.length - 1]![0]) { // out-of-order (history seed): insert sorted
      let i = a.length; while (i > 0 && a[i - 1]![0] > ts) i--;
      if (a[i - 1]?.[0] === ts) { a[i - 1]![1] = v; return; }
      a.splice(i, 0, [ts, v]);
    } else if (a.length && a[a.length - 1]![0] === ts) a[a.length - 1]![1] = v;
    else a.push([ts, v]);
    const cut = a[a.length - 1]![0] - this.keepMs;
    let n = 0; while (n < a.length && a[n]![0] < cut) n++;
    if (n) a.splice(0, n);
  }
  clear() { this.pts = []; }
  last(): [number, number] | null { return this.pts.at(-1) ?? null; }
  /** last value at or before ts, only if within maxGapMs */
  at(ts: number, maxGapMs = 30_000): number | null {
    let r: [number, number] | null = null;
    for (const p of this.pts) { if (p[0] <= ts) r = p; else break; }
    return r && ts - r[0] <= maxGapMs ? r[1] : null;
  }
  /** first value at or after ts within maxGapMs (for "first price seen at/after window open") */
  firstAfter(ts: number, maxGapMs = 30_000): number | null {
    for (const p of this.pts) if (p[0] >= ts) return p[0] - ts <= maxGapMs ? p[1] : null;
    return null;
  }
  mean(fromMs: number, toMs: number): number | null {
    let s = 0, n = 0;
    for (const p of this.pts) if (p[0] >= fromMs && p[0] <= toMs) { s += p[1]; n++; }
    return n ? s / n : null;
  }
}
