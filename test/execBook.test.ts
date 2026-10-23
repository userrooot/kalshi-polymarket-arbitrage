import { describe, expect, test } from "bun:test";
import { BookHistory, ClockModel, toVenueTimeline } from "../src/exec/bookHistory.ts";
import { dist } from "../src/exec/dist.ts";
import { defaultProfile, fixedProfile, loadProfile, mulberry32, sample, withRtt } from "../src/exec/latency.ts";
import { addTicks, defaultKalshiTick, kalshiTickFn, parseKalshiRanges, polyTickFn, roundToTick } from "../src/exec/ticks.ts";
import { limitPrice } from "../src/exec/fillSim.ts";
import { K, P, ev, newHistory } from "./execHelpers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("BookHistory", () => {
  test("at(t) returns the last event with ts <= t; null before the first", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 100, { upAsks: [[50, 1]] }));
    h.push(ev("kalshi", K, 200, { upAsks: [[51, 1]] }));
    h.push(ev("kalshi", K, 300, { upAsks: [[52, 1]] }));
    expect(h.at("kalshi", K, 99)).toBeNull();
    expect(h.at("kalshi", K, 100)!.up.asks[0]!.price).toBe(50);
    expect(h.at("kalshi", K, 199.9)!.up.asks[0]!.price).toBe(50);
    expect(h.at("kalshi", K, 200)!.up.asks[0]!.price).toBe(51);
    expect(h.at("kalshi", K, 1e9)!.up.asks[0]!.price).toBe(52);
    expect(h.at("polymarket", P, 200)).toBeNull();
    expect(h.latest("kalshi", K)!.depth.up.asks[0]!.price).toBe(52);
    expect(h.keys()).toEqual([{ venue: "kalshi", key: K }]);
    expect(h.between("kalshi", K, 100, 200).map((e) => e.t)).toEqual([200]);
  });
  test("identical consecutive depth is not stored but lastSeenRecv advances", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 100, { upAsks: [[50, 1]] }));
    expect(h.push(ev("kalshi", K, 150, { upAsks: [[50, 1]] }))).toBeNull();
    expect(h.size("kalshi", K)).toBe(1);
    expect(h.lastSeenRecv("kalshi", K)).toBe(150);
  });
  test("venue timeline subtracts the feed delay; recv timeline does not", () => {
    const h = new BookHistory({ feedDelayMs: { kalshi: 40 } });
    h.push(ev("kalshi", K, 1000, { upAsks: [[50, 1]] })); // happened at the venue at ~960
    expect(h.at("kalshi", K, 970)).not.toBeNull();
    expect(h.at("kalshi", K, 970, "recv")).toBeNull();
    expect(h.at("kalshi", K, 1000, "recv")).not.toBeNull();
  });
  test("venueTs + learned offset: clock skew cancels, jitter shows up", () => {
    const m = new ClockModel(10);
    // venue clock is 5000ms behind ours, true delay ~10ms with +-jitter
    const t1 = toVenueTimeline({ venueTs: 1000, recvTs: 6010 }, m);
    const t2 = toVenueTimeline({ venueTs: 2000, recvTs: 7030 }, m); // 20ms extra delay
    expect(t1).toBe(6000); // venueTs + (low 5010 - 10)
    expect(t2).toBe(7000);
    expect(toVenueTimeline({ venueTs: null, recvTs: 8000 }, m)).toBe(7990);
  });
  test("prunes by age and caps events per key", () => {
    const h = new BookHistory({ minutes: 1, feedDelayMs: { kalshi: 0 } });
    for (let i = 0; i < 10; i++) h.push(ev("kalshi", K, i * 30_000, { upAsks: [[50 + i, 1]] }));
    expect(h.at("kalshi", K, 0)).toBeNull(); // 4.5 min ago -> gone
    expect(h.size("kalshi", K)).toBeLessThanOrEqual(3);
    const c = new BookHistory({ maxEventsPerKey: 5, feedDelayMs: { kalshi: 0 } });
    for (let i = 0; i < 50; i++) c.push(ev("kalshi", K, i, { upAsks: [[40 + (i % 20), 1]] }));
    expect(c.size("kalshi", K)).toBeLessThanOrEqual(6);
    expect(c.latest("kalshi", K)).not.toBeNull();
  });
});

describe("tick grids", () => {
  test("kalshi default taper", () => {
    expect(defaultKalshiTick(5)).toBe(0.1);
    expect(defaultKalshiTick(50)).toBe(1);
    expect(defaultKalshiTick(95)).toBe(0.1);
  });
  test("price_ranges parse and drive the grid", () => {
    const r = parseKalshiRanges([{ start: "0.0000", end: "0.0200", step: "0.0010" }, { start: "0.0200", end: "1.0000", step: "0.0100" }])!;
    const f = kalshiTickFn(r);
    expect(f(1)).toBeCloseTo(0.1); expect(f(50)).toBe(1);
    expect(parseKalshiRanges("x")).toBeUndefined();
  });
  test("rounding and limit prices stay on the grid", () => {
    expect(roundToTick(55.3, defaultKalshiTick, "up")).toBe(56);
    expect(roundToTick(55.3, defaultKalshiTick, "down")).toBe(55);
    expect(roundToTick(55, defaultKalshiTick, "up")).toBe(55);
    expect(addTicks(9.9, 1, defaultKalshiTick)).toBe(10);
    expect(addTicks(90, 1, defaultKalshiTick)).toBe(90.1);
    expect(limitPrice(55, defaultKalshiTick, 1)).toBe(56);
    expect(limitPrice(95, defaultKalshiTick, 1)).toBe(95.1);
    expect(limitPrice(40, polyTickFn(0.01), 2)).toBe(42);
    expect(limitPrice(40, polyTickFn(0.001), 1)).toBeCloseTo(40.1);
    expect(limitPrice(99.9, defaultKalshiTick, 3)).toBe(99.9);
  });
});

describe("latency", () => {
  test("mulberry32 is deterministic", () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const sa = [a(), a(), a()], sb = [b(), b(), b()];
    expect(sa).toEqual(sb);
    expect(c()).not.toBe(sa[0]!);
  });
  test("lognormal median/sigma and empirical bootstrap", () => {
    const rng = mulberry32(7);
    const xs = Array.from({ length: 4000 }, () => sample({ kind: "lognormal", medianMs: 45, sigma: 0.4 }, rng));
    const d = dist(xs);
    expect(d.p50!).toBeGreaterThan(41); expect(d.p50!).toBeLessThan(49);
    expect(d.p99!).toBeGreaterThan(d.p50! * 1.8);
    const emp = Array.from({ length: 50 }, () => sample({ kind: "empirical", samples: [10, 20, 30] }, rng));
    expect(new Set(emp)).toEqual(new Set([10, 20, 30]));
    expect(sample({ kind: "lognormal", medianMs: 3, sigma: 0 }, rng)).toBe(3);
  });
  test("defaults, RTT override and profile file", () => {
    const d = defaultProfile();
    expect(d.polymarket.sendOneWay.medianMs).toBe(3);
    expect(d.kalshi.sendOneWay.medianMs).toBe(45);
    const o = withRtt(d, "kalshi", 200);
    expect(o.kalshi.sendOneWay.medianMs).toBe(100); expect(o.source).toBe("override");
    expect(loadProfile("/nonexistent/lat.json", {}).source).toBe("default");
    expect(loadProfile("/nonexistent/lat.json", { LAT_POLY_MS: 20 }).polymarket.ackOneWay.medianMs).toBe(10);
    const dir = mkdtempSync(join(tmpdir(), "lat-"));
    const f = join(dir, "latency.json");
    writeFileSync(f, JSON.stringify({ source: "probe", kalshi: { sendOneWay: { kind: "empirical", samples: [60, 70] } } }));
    const p = loadProfile(f, {});
    expect(p.source).toBe("probe");
    expect(p.kalshi.sendOneWay.kind).toBe("empirical");
    expect(p.polymarket.sendOneWay.medianMs).toBe(3); // untouched default
    expect(fixedProfile(100, 10).kalshi.sendOneWay.medianMs).toBe(50);
  });
});

import { KalshiBook } from "../src/feeds/kalshiOrderbook.ts";
import { kalshiDepthFrom } from "../src/exec/hub.ts";
describe("Kalshi depth conversion", () => {
  test("YES/NO bid ladders become Up/Down ask ladders (ask = 100 - opposite bid)", () => {
    const b = new KalshiBook(true);
    b.snapshot({ yes_dollars_fp: [["0.4000", "100"], ["0.3500", "50"]], no_dollars_fp: [["0.5500", "30"], ["0.7000", "10"]] }); // NO on YES scale: bids 45 and 30
    const l = b.levels();
    expect(l.yesBids).toEqual([{ price: 40, size: 100 }, { price: 35, size: 50 }]);
    expect(l.noBids).toEqual([{ price: 45, size: 30 }, { price: 30, size: 10 }]);
    const d = kalshiDepthFrom("T", l.yesBids, l.noBids, "ws");
    expect(d.up.asks).toEqual([{ price: 55, size: 30 }, { price: 70, size: 10 }]);   // Up ask = 100 - NO bid
    expect(d.down.asks).toEqual([{ price: 60, size: 100 }, { price: 65, size: 50 }]); // Down ask = 100 - YES bid
    expect(d.up.bids[0]!.price).toBe(40); expect(d.down.bids[0]!.price).toBe(45);
    expect(d.minSize).toBe(0.01); expect(d.quality).toBe("ws");
    expect(kalshiDepthFrom("T", [{ price: 40, size: 1 }], [], "rest-coarse").quality).toBe("rest-coarse");
  });
});
