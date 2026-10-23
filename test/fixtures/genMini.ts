// Deterministic mini recording used by test/execReplay.test.ts.
//   bun run test/fixtures/genMini.ts   -> rewrites test/fixtures/mini.ndjson
// Exports both the raw recorded lines AND the DepthEvents they must decode to (built by hand, independently of the adapter).
import { writeFileSync } from "node:fs";
import type { RecordLine } from "../../src/exec/recorder.ts";
import type { DepthEvent, Level, VenueDepth } from "../../src/exec/types.ts";
import { defaultKalshiTick, polyTickFn } from "../../src/exec/ticks.ts";

export const T0 = Date.UTC(2026, 0, 2, 3, 0, 0); // on a 15-minute boundary
export const K_TICKER = "KXBTC15M-MINI", UP = "UPTOKEN0001", DOWN = "DNTOKEN0001";
const K_LAG = 40, P_LAG = 5;

type M = Map<number, number>;
const mk = (o: Record<number, number>): M => new Map(Object.entries(o).map(([p, s]) => [Number(p), s]));
const lv = (m: M, asc: boolean): Level[] => [...m].filter(([, s]) => s > 0).sort((a, b) => (asc ? a[0] - b[0] : b[0] - a[0])).map(([price, size]) => ({ price, size }));

const k = { noShown: mk({ 55: 100, 58: 100 }), yes: mk({ 53: 100, 50: 100 }) };
const p = { upA: mk({ 52: 100, 55: 100 }), upB: mk({ 48: 100 }), dnA: mk({ 50: 100, 53: 100 }), dnB: mk({ 46: 100 }) };
const inv = (m: M): M => new Map([...m].map(([a, s]) => [100 - a, s] as [number, number]));

const kalshiDepth = (): VenueDepth => ({
  up: { asks: lv(k.noShown, true), bids: lv(k.yes, false) },
  down: { asks: lv(inv(k.yes), true), bids: lv(inv(k.noShown), false) },
  tick: defaultKalshiTick, minSize: 0.01, quality: "ws",
});
const polyDepth = (): VenueDepth => ({
  up: { asks: lv(p.upA, true), bids: lv(p.upB, false) }, down: { asks: lv(p.dnA, true), bids: lv(p.dnB, false) },
  tick: polyTickFn(0.01), minSize: 5, quality: "ws",
});

export function build(): { lines: RecordLine[]; events: DepthEvent[] } {
  const lines: RecordLine[] = [], events: DepthEvent[] = [];
  let seq = 0, i = 0;
  const jitter = () => (i++ % 4) * 0.25;
  const closeMs = T0 + 900_000;
  const emit = (src: string, venue: "kalshi" | "polymarket", x: number, raw: object, key: string, depth: VenueDepth) => {
    const venueTs = T0 + x, recv = venueTs + (venue === "kalshi" ? K_LAG : P_LAG) + jitter();
    lines.push({ v: 1, src, recv, recvMono: recv - T0, venueTs, raw: JSON.stringify(raw) });
    events.push({ venue, key, venueTs, recvTs: recv, depth, closeMs });
  };
  const kLevels = (m: M) => [...m].map(([a, s]) => [(a / 100).toFixed(4), String(s)]);
  const kSnap = (x: number) => emit("kalshiBook(ws)", "kalshi", x, { type: "orderbook_snapshot", sid: 1, seq: ++seq, sending_ts_ms: T0 + x, msg: { market_ticker: K_TICKER, yes_dollars_fp: kLevels(k.yes), no_dollars_fp: kLevels(k.noShown) } }, K_TICKER, kalshiDepth());
  const kDelta = (x: number, side: "yes" | "no", price: number, delta: number) => {
    const m = side === "yes" ? k.yes : k.noShown;
    const n = (m.get(price) ?? 0) + delta; n > 0 ? m.set(price, n) : m.delete(price);
    emit("kalshiBook(ws)", "kalshi", x, { type: "orderbook_delta", sid: 1, seq: ++seq, sending_ts_ms: T0 + x, msg: { market_ticker: K_TICKER, price_dollars: (price / 100).toFixed(4), delta_fp: String(delta), side } }, K_TICKER, kalshiDepth());
  };
  const rows = (m: M) => [...m].map(([a, s]) => ({ price: (a / 100).toFixed(2), size: String(s) }));
  const pBook = (x: number, tok: string, a: M, b: M) => emit("polyBook", "polymarket", x, { event_type: "book", asset_id: tok, market: "0xmini", timestamp: String(T0 + x), asks: rows(a), bids: rows(b) }, "poly:" + UP, polyDepth());
  const pSet = (x: number, tok: string, m: M, price: number, size: number) => {
    size > 0 ? m.set(price, size) : m.delete(price);
    emit("polyBook", "polymarket", x, { event_type: "price_change", market: "0xmini", timestamp: String(T0 + x), price_changes: [{ asset_id: tok, price: (price / 100).toFixed(2), side: "SELL", size: String(size), best_bid: "0.46", best_ask: "0.50" }] }, "poly:" + UP, polyDepth());
  };
  // subscription line (outbound), as recorded by ws.ts
  lines.push({ v: 1, src: "polyBook>", recv: T0 - 5, recvMono: 0, raw: JSON.stringify({ assets_ids: [UP, DOWN], type: "market", custom_feature_enabled: true }) });
  kSnap(0);
  // the first poly book (UP only) cannot produce a depth event yet: DOWN book unknown -> adapter must emit nothing for it
  lines.push({ v: 1, src: "polyBook", recv: T0 + 4 + P_LAG, recvMono: 0, venueTs: T0 + 4, raw: JSON.stringify({ event_type: "book", asset_id: UP, market: "0xmini", timestamp: String(T0 + 4), asks: rows(p.upA), bids: rows(p.upB) }) });
  pBook(8, DOWN, p.dnA, p.dnB);
  lines.push({ v: 1, src: "polyLive", recv: T0 + 20, recvMono: 0, raw: "{\"topic\":\"ignored\"}" });
  // (kSnap heartbeats between episodes keep the Kalshi feed "fresh" for EPISODE_STALE_MS; seq must stay chronological)
  // Ep1 (poly kills, 300ms): K_UP 55 + P_DOWN 30
  pSet(1000, DOWN, p.dnA, 30, 100); pSet(1300, DOWN, p.dnA, 30, 0);
  kSnap(2000);
  // Ep2 (kalshi kills, 80ms): K_DOWN 35 + P_UP 52
  kDelta(3000, "yes", 65, 100); kDelta(3080, "yes", 65, -100);
  kSnap(4000);
  // Ep3 (poly kills, 40ms): K_DOWN 47 + P_UP 40
  pSet(5000, UP, p.upA, 40, 100); pSet(5040, UP, p.upA, 40, 0);
  kSnap(6000);
  // Ep4 (poly kills, 1200ms)
  pSet(7000, DOWN, p.dnA, 30, 100); pSet(8200, DOWN, p.dnA, 30, 0);
  kSnap(8000);
  // Ep5 (depth consumed at 5 contracts left, 500ms)
  pSet(9000, DOWN, p.dnA, 30, 100); pSet(9500, DOWN, p.dnA, 30, 4);
  pSet(9600, DOWN, p.dnA, 30, 0);
  kSnap(10000);
  // heartbeats
  kSnap(11000); pBook(11005, UP, p.upA, p.upB); pBook(11010, DOWN, p.dnA, p.dnB);
  kDelta(12000, "no", 58, 10);
  return { lines, events };
}

if (import.meta.main) {
  const { lines } = build();
  writeFileSync(new URL("./mini.ndjson", import.meta.url), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  console.log(`wrote ${lines.length} lines`);
}
