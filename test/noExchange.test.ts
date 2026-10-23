import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { cfReset, cfSpot, cfAvg60, cfSettle } from "../src/feeds/kalshiIndex.ts";
import { fetchKalshi } from "../src/kalshi.ts";

describe("no non-official spot sources", () => {
  test("src/ mentions no exchange price source", async () => {
    const bad = /coinbase|binance|kraken|bitstamp|gemini|crypto\.com|lmax/i;
    const hits: string[] = [];
    for await (const f of new Glob("**/*.ts").scan({ cwd: "src", absolute: true })) {
      (await Bun.file(f).text()).split("\n").forEach((l, i) => { if (bad.test(l)) hits.push(`${f}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
    expect(await Bun.file("src/feeds/brti.ts").exists()).toBe(false);
  });
  test("no feed data => spot, avg and settlement are null", () => {
    cfReset();
    expect(cfSpot()).toBeNull(); expect(cfAvg60()).toBeNull(); expect(cfSettle()).toBeNull();
  });
  test("unauthenticated Kalshi snapshot has spot null + a clear spotError", async () => {
    const orig = globalThis.fetch;
    const m = { ticker: "KXBTC15M-T", title: "t", floor_strike: 68000, open_time: new Date(Date.now() - 60000).toISOString(), close_time: new Date(Date.now() + 600000).toISOString() };
    globalThis.fetch = (async (u: any) => new Response(JSON.stringify(String(u).includes("orderbook") ? { orderbook_fp: { yes_dollars: [["0.40", "10"]], no_dollars: [["0.55", "10"]] } } : { markets: [m] }), { headers: { "content-type": "application/json" } })) as any;
    try {
      cfReset();
      const s = await fetchKalshi();
      expect(s).not.toBeNull();
      expect(s!.spot).toBeNull(); expect(s!.spotSource).toBeNull(); expect(s!.spotAvg60).toBeNull(); expect(s!.spotSettle).toBeNull();
      expect(typeof s!.spotError).toBe("string"); expect(s!.spotError!.length).toBeGreaterThan(3);
      expect(s!.strike).toBe(68000); expect(s!.strikeSource).toBe("kalshi floor_strike");
    } finally { globalThis.fetch = orig; }
  });
});
