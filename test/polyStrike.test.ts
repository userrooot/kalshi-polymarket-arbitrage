import { beforeEach, describe, expect, test } from "bun:test";
import { STRIKE_SOURCES, fetchCryptoPrice, fetchPolyResult, resetStrikeCache, resolveStrike, type StrikeDeps } from "../src/polymarket.ts";

const W = 1792758600; // a 15m window start (unix s)

function deps(o: Partial<StrikeDeps> & { stored?: Record<number, { value: number; source: string }> } = {}) {
  const saved: [number, number, string][] = [];
  const calls = { fetchOpen: 0, twapAt: 0 };
  const stored = o.stored ?? {};
  const d: StrikeDeps = {
    fetchOpen: async (s) => { calls.fetchOpen++; return o.fetchOpen ? o.fetchOpen(s) : null; },
    twapAt: (s) => { calls.twapAt++; return o.twapAt ? o.twapAt(s) : null; },
    load: (s) => stored[s] ?? null,
    save: (s, v, src) => { saved.push([s, v, src]); stored[s] = { value: v, source: src }; },
  };
  return { d, saved, calls, stored };
}

beforeEach(() => resetStrikeCache());

describe("Polymarket Price to Beat priority", () => {
  test("1. eventMetadata.priceToBeat wins over everything", async () => {
    const { d, saved, calls } = deps({ fetchOpen: async () => 2, twapAt: () => 3 });
    expect(await resolveStrike(W, 81619.36029110718, 0, d)).toEqual({ value: 81619.36029110718, source: STRIKE_SOURCES.priceToBeat });
    expect(calls.fetchOpen).toBe(0);
    expect(saved).toEqual([[W, 81619.36029110718, STRIKE_SOURCES.priceToBeat]]);
  });
  test("2. crypto-price openPrice when priceToBeat absent; then cached (no more fetches)", async () => {
    const { d, calls } = deps({ fetchOpen: async () => 81583.01842135222, twapAt: () => 1 });
    expect(await resolveStrike(W, undefined, 0, d)).toEqual({ value: 81583.01842135222, source: STRIKE_SOURCES.cryptoPrice });
    await resolveStrike(W, null, 60_000, d);
    expect(calls.fetchOpen).toBe(1);
    expect(calls.twapAt).toBe(0);
  });
  test("3. TWAP-feed value at window start when the endpoint fails", async () => {
    const { d } = deps({ fetchOpen: async () => { throw new Error("down"); }, twapAt: (s) => (s === W ? 81500.5 : null) });
    expect(await resolveStrike(W, undefined, 0, d)).toEqual({ value: 81500.5, source: STRIKE_SOURCES.twapFeed });
  });
  test("4. nothing -> null (never another source); endpoint retried at most every 5s", async () => {
    const { d, calls, saved } = deps();
    expect(await resolveStrike(W, undefined, 0, d)).toBeNull();
    expect(await resolveStrike(W, undefined, 1000, d)).toBeNull();
    expect(calls.fetchOpen).toBe(1);
    expect(await resolveStrike(W, undefined, 5000, d)).toBeNull();
    expect(calls.fetchOpen).toBe(2);
    expect(saved).toEqual([]);
  });
  test("lower source is upgraded when a better one appears, and priceToBeat overrides at resolution", async () => {
    let open: number | null = null;
    const { d } = deps({ fetchOpen: async () => open, twapAt: () => 81500.5 });
    expect((await resolveStrike(W, undefined, 0, d))!.source).toBe(STRIKE_SOURCES.twapFeed);
    open = 81500.25;
    expect(await resolveStrike(W, undefined, 5000, d)).toEqual({ value: 81500.25, source: STRIKE_SOURCES.cryptoPrice });
    expect(await resolveStrike(W, "81500.25", 900_000, d)).toEqual({ value: 81500.25, source: STRIKE_SOURCES.priceToBeat });
  });
  test("restart mid-window: persisted strike is used without fetching", async () => {
    const { d, calls } = deps({ stored: { [W]: { value: 81583.01842135222, source: STRIKE_SOURCES.cryptoPrice } }, fetchOpen: async () => 1 });
    expect(await resolveStrike(W, undefined, 0, d)).toEqual({ value: 81583.01842135222, source: STRIKE_SOURCES.cryptoPrice });
    expect(calls.fetchOpen).toBe(0);
  });
  test("bad values are ignored", async () => {
    const { d } = deps({ fetchOpen: async () => NaN, twapAt: () => -1 });
    expect(await resolveStrike(W, "abc", 0, d)).toBeNull();
  });
});

describe("HTTP parsing (mocked fetch)", () => {
  const withFetch = async (h: (u: string) => any, f: () => Promise<void>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any) => new Response(JSON.stringify(h(String(u))), { headers: { "content-type": "application/json" } })) as any;
    try { await f(); } finally { globalThis.fetch = orig; }
  };
  test("crypto-price request carries the required params and parses open/close", async () => {
    let url = "";
    await withFetch((u) => { url = u; return { openPrice: 81426.84723133073, closePrice: null, completed: false, incomplete: true }; }, async () => {
      expect(await fetchCryptoPrice(W)).toEqual({ openPrice: 81426.84723133073, closePrice: null, completed: false });
    });
    const q = new URL(url).searchParams;
    expect(url.startsWith("https://polymarket.com/api/crypto/crypto-price?")).toBe(true);
    expect(q.get("symbol")).toBe("BTC");
    expect(q.get("eventStartTime")).toBe("2026-10-23T12:30:00Z");
    expect(q.get("endDate")).toBe("2026-10-23T12:45:00Z");
    expect(q.get("variant")).toBe("fifteen");
    expect(q.get("twapEnabled")).toBe("true");
    expect(q.get("twapLookbackSeconds")).toBe("60");
  });
  test("settlement: gamma priceToBeat/finalPrice; missing finalPrice falls back to completed crypto-price close", async () => {
    const ev = (meta: any) => [{ slug: "s", eventMetadata: meta, markets: [{ closed: true, outcomes: '["Up","Down"]', outcomePrices: '["0","1"]' }] }];
    await withFetch(() => ev({ priceToBeat: 81619.36029110718, finalPrice: 81426.84723133073 }), async () => {
      expect(await fetchPolyResult("2026-10-23T12:15:00Z", { fetchCp: async () => { throw new Error("not needed"); } }))
        .toEqual({ result: "DOWN", strike: 81619.36029110718, finalPrice: 81426.84723133073 });
    });
    await withFetch(() => ev({ priceToBeat: 81619.36029110718 }), async () => {
      expect(await fetchPolyResult("2026-10-23T12:15:00Z", { fetchCp: async () => ({ openPrice: 1, closePrice: 81426.84723133073, completed: true }) }))
        .toEqual({ result: "DOWN", strike: 81619.36029110718, finalPrice: 81426.84723133073 });
    });
    await withFetch(() => ev(undefined), async () => {
      expect(await fetchPolyResult("2026-10-23T12:15:00Z", { load: () => ({ value: 81619.36, source: "x" }), fetchCp: async () => ({ openPrice: 5, closePrice: 6, completed: false }) }))
        .toEqual({ result: "DOWN", strike: 81619.36, finalPrice: null });
    });
  });
});
