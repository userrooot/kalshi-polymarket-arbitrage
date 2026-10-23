import { describe, expect, test } from "bun:test";
import { KalshiBook, SeqTracker } from "../src/feeds/kalshiOrderbook.ts";

const snap = { market_ticker: "T", yes_dollars_fp: [["0.0800", "300.00"], ["0.4000", "100.00"]], no_dollars_fp: [["0.5500", "50.00"], ["0.9000", "10.00"]] };

describe("KalshiBook (use_yes_price: NO levels on the YES scale)", () => {
  test("snapshot -> top/asks", () => {
    const b = new KalshiBook(true); b.snapshot(snap);
    // best NO bid = 100 - min(shown NO) = 100 - 55 = 45; best YES bid = 40
    expect(b.top()).toEqual({ yesBid: 40, noBid: 45 });
    expect(b.asks()).toEqual({ upAsk: 55, downAsk: 60 });
  });
  test("deltas add, shrink, remove at <=0, and shift the top", () => {
    const b = new KalshiBook(true); b.snapshot(snap);
    b.delta({ price_dollars: "0.4000", delta_fp: "-100.00", side: "yes" }); // removes 40 -> best yes 8
    expect(b.top().yesBid).toBe(8);
    b.delta({ price_dollars: "0.4100", delta_fp: "5.00", side: "yes" });
    expect(b.top().yesBid).toBe(41);
    b.delta({ price_dollars: "0.5500", delta_fp: "-20.00", side: "no" }); // 30 left, level stays
    expect(b.top().noBid).toBe(45);
    b.delta({ price_dollars: "0.5500", delta_fp: "-54.00", side: "no" }); // below 0 -> removed
    expect(b.top().noBid).toBe(10); // shown 0.90 -> 100-90
    b.delta({ price_dollars: "0.9000", delta_fp: "-10.00", side: "no" });
    expect(b.top().noBid).toBeNull();
    expect(b.asks().upAsk).toBeNull();
  });
  test("either snapshot key may be absent; deltas before a snapshot are refused", () => {
    const b = new KalshiBook(true);
    expect(b.delta({ price_dollars: "0.5", delta_fp: "1", side: "yes" })).toBe("no-snapshot");
    b.snapshot({ market_ticker: "T", yes_dollars_fp: [["0.3000", "1.00"]] });
    expect(b.top()).toEqual({ yesBid: 30, noBid: null });
    expect(b.delta({ price_dollars: "0.5", delta_fp: "1", side: "yes" })).toBe("ok");
  });
  test("reset drops the book until the next snapshot", () => {
    const b = new KalshiBook(true); b.snapshot(snap); b.reset();
    expect(b.snapshotted).toBe(false);
    expect(b.top()).toEqual({ yesBid: null, noBid: null });
  });
});

describe("KalshiBook (NO levels in NO-price terms, REST convention)", () => {
  test("same market, same derived values", () => {
    const yesScale = new KalshiBook(true); yesScale.snapshot(snap);
    const noScale = new KalshiBook(false);
    noScale.snapshot({ yes_dollars_fp: [["0.0800", "300"], ["0.4000", "100"]], no_dollars_fp: [["0.4500", "50"], ["0.1000", "10"]] });
    expect(noScale.top()).toEqual(yesScale.top());
    expect(noScale.asks()).toEqual({ upAsk: 55, downAsk: 60 });
    noScale.delta({ price_dollars: "0.4800", delta_fp: "7", side: "no" });
    expect(noScale.top().noBid).toBe(48);
  });
});

describe("SeqTracker", () => {
  test("contiguous ok, gap detected and rebased, per-sid independence", () => {
    const s = new SeqTracker();
    expect(s.check(1, 10)).toBe("first");
    expect(s.check(1, 11)).toBe("ok");
    expect(s.check(1, 13)).toBe("gap");
    expect(s.check(1, 14)).toBe("ok");
    expect(s.check(2, 1)).toBe("first");
    s.rebase(1, 100);
    expect(s.check(1, 101)).toBe("ok");
    expect(s.check(1, 101)).toBe("gap"); // duplicate
  });
});
