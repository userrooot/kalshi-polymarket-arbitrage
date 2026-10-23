import { describe, expect, test } from "bun:test";
import { execOptsFromConfig, simulateLeg, type ExecOpts } from "../src/exec/fillSim.ts";
import { fixedProfile, mulberry32, sampleAttempt, type LegSamples } from "../src/exec/latency.ts";
import { allStrategyStats, runAll, runAttempt, settledPnlUsd, strategyStats, type Decision } from "../src/exec/strategies.ts";
import { defaultKalshiTick } from "../src/exec/ticks.ts";
import type { LegOrder } from "../src/exec/types.ts";
import { K, P, ev, flat, newHistory } from "./execHelpers.ts";

const opts = (o: Partial<ExecOpts> = {}): ExecOpts => execOptsFromConfig({ slippageTicks: 1, raceWindowMs: 2, pLoseRace: 0, feesOn: false, unwindMode: "bid", unwindAfterMs: 500, orderType: "IOC", ...o });
const prof = fixedProfile(90, 6); // kalshi one-way 45, poly one-way 3, no process / feed delay
const samp = (sendMs: number, ackMs = sendMs, raceU = 0.99): LegSamples => ({ sendMs, processMs: 0, ackMs, feedMs: 0, raceU });
const kOrder = (qty: number, limit: number, type: "IOC" | "FOK" = "IOC"): LegOrder => ({ venue: "kalshi", side: "UP", type, qty, limitPrice: limit });

describe("simulateLeg", () => {
  test("fills at the arrival-time book; ack = arrival + ack latency", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 100]] }));
    const f = simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45, 40) }, h, prof.kalshi, opts());
    expect(f.status).toBe("FILLED");
    expect(f.qty).toBe(10); expect(f.vwap).toBe(55);
    expect(f.arriveAt).toBe(1045); expect(f.ackAt).toBe(1085);
    expect(f.arrivalAsk).toBe(55);
  });
  test("price moved away before arrival => MISS price_moved", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 100]] }));
    h.push(ev("kalshi", K, 1030, { upAsks: [[60, 100]] })); // moved 15ms before arrival
    const f = simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts());
    expect(f.status).toBe("MISS"); expect(f.missReason).toBe("price_moved"); expect(f.arrivalAsk).toBe(60);
  });
  test("a move AFTER arrival does not matter", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 100]] }));
    h.push(ev("kalshi", K, 1060, { upAsks: [[60, 100]] }));
    expect(simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts()).status).toBe("FILLED");
  });
  test("depth consumed: IOC partial, FOK none", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 4]] }));
    const ioc = simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts());
    expect(ioc.status).toBe("PARTIAL"); expect(ioc.qty).toBe(4); expect(ioc.missReason).toBe("depth_consumed");
    const fok = simulateLeg(kOrder(10, 56, "FOK"), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts());
    expect(fok.status).toBe("MISS"); expect(fok.qty).toBe(0); expect(fok.missReason).toBe("fok_incomplete");
  });
  test("walks the ladder up to the limit only (slippage tolerance)", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 5], [56, 10], [57, 100]] }));
    const f = simulateLeg(kOrder(12, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts());
    expect(f.qty).toBe(12); expect(f.vwap).toBeCloseTo((5 * 55 + 7 * 56) / 12);
    const g = simulateLeg(kOrder(20, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts());
    expect(g.qty).toBe(15); expect(g.status).toBe("PARTIAL"); // 57 is beyond the limit
  });
  test("below min size / no book", () => {
    const h = newHistory();
    h.push(ev("polymarket", P, 0, { upAsks: [[40, 100]] }));
    const o: LegOrder = { venue: "polymarket", side: "UP", type: "IOC", qty: 3, limitPrice: 41 };
    expect(simulateLeg(o, { key: P, sentAt: 100, seenAsk: 40, samples: samp(3) }, h, prof.polymarket, opts()).missReason).toBe("below_min_size");
    expect(simulateLeg({ ...o, qty: 10 }, { key: P, sentAt: -100, seenAsk: 40, samples: samp(3) }, h, prof.polymarket, opts()).missReason).toBe("no_book");
    expect(simulateLeg({ ...o, qty: 10 }, { key: "nope", sentAt: 100, seenAsk: 40, samples: samp(3) }, h, prof.polymarket, opts()).missReason).toBe("no_book");
  });
  test("race haircut: a level that shrinks within RACE_WINDOW_MS after arrival counts as taken", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 100], [56, 100]] }));
    h.push(ev("kalshi", K, 1046, { upAsks: [[55, 10], [56, 100]] })); // 1ms after arrival (1045)
    const run = (raceWindowMs: number) => simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45) }, h, prof.kalshi, opts({ raceWindowMs }));
    expect(run(2).vwap).toBe(56);   // best level treated as taken -> next level
    expect(run(0.5).vwap).toBe(55); // event outside the window
  });
  test("P_LOSE_RACE drops the best level when it died within 20ms of arrival", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[55, 100], [56, 100]] }));
    h.push(ev("kalshi", K, 1060, { upAsks: [[56, 100]] })); // 15ms after arrival, best level gone
    const run = (raceU: number) => simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45, 45, raceU) }, h, prof.kalshi, opts({ pLoseRace: 0.3 }));
    expect(run(0.1).vwap).toBe(56); // lost the race
    expect(run(0.9).vwap).toBe(55); // won it
    // nothing died -> never lost, even with an unlucky draw
    const h2 = newHistory(); h2.push(ev("kalshi", K, 0, { upAsks: [[55, 100], [56, 100]] }));
    expect(simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45, 45, 0.0) }, h2, prof.kalshi, opts({ pLoseRace: 1 })).vwap).toBe(55);
    // all eligible depth lost -> race_lost
    const h3 = newHistory(); h3.push(ev("kalshi", K, 0, { upAsks: [[55, 100]] })); h3.push(ev("kalshi", K, 1060, { upAsks: [[57, 100]] }));
    const f = simulateLeg(kOrder(10, 56), { key: K, sentAt: 1000, seenAsk: 55, samples: samp(45, 45, 0.0) }, h3, prof.kalshi, opts({ pLoseRace: 1 }));
    expect(f.status).toBe("MISS"); expect(f.missReason).toBe("race_lost");
  });
  test("Polymarket secondsDelay shifts the arrival; fees only when FEES_ON", () => {
    const h = newHistory();
    h.push(ev("polymarket", P, 0, { upAsks: [[40, 100]] }));
    h.push(ev("polymarket", P, 1500, { upAsks: [[70, 100]] }));
    const o: LegOrder = { venue: "polymarket", side: "UP", type: "IOC", qty: 10, limitPrice: 41 };
    const lat = { ...prof.polymarket, secondsDelayMs: 1000 };
    const f = simulateLeg(o, { key: P, sentAt: 1000, seenAsk: 40, samples: samp(3) }, h, lat, opts());
    expect(f.arriveAt).toBe(2003); expect(f.status).toBe("MISS");
    const a = simulateLeg(o, { key: P, sentAt: 100, seenAsk: 40, samples: samp(3) }, h, prof.polymarket, opts({ feesOn: true }));
    expect(a.fee).toBeCloseTo(10 * 0.07 * 0.4 * 0.6 * 100);
    expect(simulateLeg(kOrder(10, 56), { key: K, sentAt: 1, seenAsk: 55, samples: samp(45) }, (() => { const x = newHistory(); x.push(ev("kalshi", K, 0, { upAsks: [[55, 99]] })); return x; })(), prof.kalshi, opts({ feesOn: true })).fee).toBe(Math.ceil(0.07 * 10 * 0.55 * 0.45 * 100));
  });
});

// ------------------------------------------------------------------------------------------------ strategies
const dec = (over: Partial<Decision> = {}): Decision => ({
  combo: "K_UP+P_DOWN", qty: 10, decidedAt: 1000,
  kalshi: { key: K, side: "UP", seenAsk: 50 }, poly: { key: P, side: "DOWN", seenAsk: 40 }, ...over,
});
/** Stable books: Kalshi Up ask 50 (bid 49), Polymarket Down ask 40 (bid 39). */
function stable() { const h = newHistory(); flat(h, 0, { up: 50, down: 52 }, { up: 62, down: 40 }); return h; }
const S = sampleAttempt(prof, mulberry32(1));

describe("strategies", () => {
  test("stable book: all four strategies fill both; sequencing shows in timeToBoth", () => {
    const h = stable();
    const rs = runAll(dec(), h, prof, { ...opts(), samples: S });
    expect(rs.map((r) => r.outcome)).toEqual(["BOTH", "BOTH", "BOTH", "BOTH"]);
    const by = Object.fromEntries(rs.map((r) => [r.strategy, r]));
    expect(by.NAIVE!.timeToBothMs).toBe(0);
    expect(by.PAR!.timeToBothMs).toBe(90);              // 45 out + 45 ack on Kalshi, Polymarket 6
    expect(by.K_THEN_P!.timeToBothMs).toBe(96);         // Polymarket sent at the Kalshi ack (90) + 6
    expect(by.P_THEN_K!.timeToBothMs).toBe(96);         // Kalshi sent at the Polymarket ack (6) + 90
    expect(by.K_THEN_P!.poly.sentAt).toBe(by.K_THEN_P!.kalshi.ackAt);
    expect(by.PAR!.expPnlUsd).toBeCloseTo(10 * 10 / 100);
    expect(by.PAR!.hedgedQty).toBe(10);
  });
  test("Kalshi ask runs away during flight: PAR leaves leg risk and unwinds, K_THEN_P stays flat, P_THEN_K has leg risk", () => {
    const h = stable();
    h.push(ev("kalshi", K, 1020, { upAsks: [[80, 1000]], upBids: [[79, 1000]], downAsks: [[52, 1000]], downBids: [[51, 1000]] }));
    const rs = Object.fromEntries(runAll(dec(), h, prof, { ...opts(), samples: S }).map((r) => [r.strategy, r]));
    expect(rs.NAIVE!.outcome).toBe("BOTH"); // the old model never sees this
    expect(rs.PAR!.kalshi.missReason).toBe("price_moved");
    expect(rs.PAR!.outcome).toBe("ONE"); expect(rs.PAR!.retried).toBe(false); // edge gone (40 + 80 > 100): do not chase
    expect(rs.PAR!.unwound).toBe(true);
    expect(rs.PAR!.unwindPnlCents).toBeCloseTo(10 * (39 - 40)); // sold 10 at the bid 39 after buying at 40
    expect(rs.PAR!.expPnlUsd).toBeCloseTo(-0.1);
    expect(rs.K_THEN_P!.outcome).toBe("NONE"); expect(rs.K_THEN_P!.poly.missReason).toBe("not_sent"); expect(rs.K_THEN_P!.poly.qty).toBe(0);
    expect(rs.P_THEN_K!.outcome).toBe("ONE"); expect(rs.P_THEN_K!.poly.status).toBe("FILLED"); expect(rs.P_THEN_K!.unwound).toBe(true);
  });
  test("UNWIND_MODE=hold keeps the leg (no unwind PnL)", () => {
    const h = stable();
    h.push(ev("kalshi", K, 1020, { upAsks: [[80, 1000]], upBids: [[79, 1000]] }));
    const r = runAttempt("PAR", dec(), h, prof, { ...opts({ unwindMode: "hold" }), samples: S });
    expect(r.outcome).toBe("ONE"); expect(r.unwound).toBe(false); expect(r.unwindPnlCents).toBeNull();
    expect(settledPnlUsd(r, false, true)).toBeCloseTo(10 * (100 - 40) / 100); // poly leg held and won
    expect(settledPnlUsd(r, false, false)).toBeCloseTo(-4);
  });
  test("hedge retry: the short leg is re-sent once at the then-current ask when edge >= 0", () => {
    const h = stable();
    h.push(ev("kalshi", K, 1020, { upAsks: [[58, 1000]], upBids: [[57, 1000]] })); // 58 + 40 = 98 < 100, beyond the 51 limit
    const r = runAttempt("PAR", dec(), h, prof, { ...opts(), samples: S });
    expect(r.retried).toBe(true);
    expect(r.outcome).toBe("BOTH");
    expect(r.kalshi.vwap).toBe(58);
    expect(r.kalshi.sentAt).toBe(1000); // merged leg keeps the first send time, ack is the retry's
    expect(r.kalshi.ackAt).toBeGreaterThan(1090);
    expect(r.expPnlUsd).toBeCloseTo((10 * (100 - 58 - 40)) / 100);
  });
  test("partial hedge: depth for only part of the Kalshi leg", () => {
    const h = newHistory();
    h.push(ev("kalshi", K, 0, { upAsks: [[50, 4]], upBids: [[49, 100]] }));
    h.push(ev("polymarket", P, 0, { downAsks: [[40, 1000]], downBids: [[39, 1000]] }));
    const r = runAttempt("PAR", dec(), h, prof, { ...opts(), samples: S });
    expect(r.kalshi.status).toBe("PARTIAL"); expect(r.kalshi.qty).toBe(4);
    expect(r.hedgedQty).toBe(4); expect(r.outcome).toBe("ONE");
    expect(r.retried).toBe(true); // retry sent, but our own first fill already took the 4 shares: nothing more
  });
  test("deterministic given a seed; different seeds differ; same samples across strategies", () => {
    const h = stable();
    const p = { ...prof, kalshi: { ...prof.kalshi, sendOneWay: { kind: "lognormal" as const, medianMs: 45, sigma: 0.4 } } };
    const a = runAttempt("PAR", dec(), h, p, { ...opts(), seed: 5 }), b = runAttempt("PAR", dec(), h, p, { ...opts(), seed: 5 }), c = runAttempt("PAR", dec(), h, p, { ...opts(), seed: 6 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.kalshi.arriveAt).not.toBe(c.kalshi.arriveAt);
    const all = runAll(dec(), h, p, { ...opts(), seed: 9 });
    expect(all[1]!.kalshi.arriveAt).toBe(all[2]!.kalshi.arriveAt); // PAR and K_THEN_P send Kalshi at t0 with the same sample
  });
  test("strategyStats aggregates rates, distributions, slippage, pnl", () => {
    const good = stable();
    const bad = stable(); bad.push(ev("kalshi", K, 1020, { upAsks: [[80, 1000]], upBids: [[79, 1000]] }));
    const atts = [...runAll(dec(), good, prof, { ...opts(), samples: S }), ...runAll(dec(), bad, prof, { ...opts(), samples: S })];
    const par = strategyStats(atts, "PAR");
    expect(par.attempts).toBe(2); expect(par.bothRate).toBe(0.5); expect(par.oneLegRate).toBe(0.5); expect(par.noneRate).toBe(0);
    expect(par.kalshiFillRate).toBe(0.5); expect(par.polyFillRate).toBe(1);
    expect(par.bothMs.n).toBe(1); expect(par.bothMs.p50).toBe(90);
    expect(par.polyFillMs.p50).toBe(6);
    expect(par.expPnlPerAttemptUsd).toBeCloseTo((1 - 0.1) / 2);
    expect(par.avgSlippageCents).toBe(0);
    expect(allStrategyStats(atts).map((s) => s.strategy)).toEqual(["NAIVE", "PAR", "K_THEN_P", "P_THEN_K"]);
    expect(strategyStats(atts, "NAIVE").bothRate).toBe(1);
    atts[1]!.pnlUsd = 5; // settled value wins over the expectation
    expect(strategyStats(atts, "PAR").expPnlPerAttemptUsd).toBeCloseTo((5 - 0.1) / 2);
  });
  test("tick grid is read from the venue depth (limit not off-grid)", () => {
    const h = stable();
    expect(defaultKalshiTick(50)).toBe(1);
    const r = runAttempt("PAR", dec({ kalshi: { key: K, side: "UP", seenAsk: 50 } }), h, prof, { ...opts({ slippageTicks: 0 }), samples: S });
    expect(r.outcome).toBe("BOTH");
  });
});
