import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookHistory } from "../src/exec/bookHistory.ts";
import { EpisodeTracker } from "../src/exec/episodes.ts";
import { defaultProfile, medianOf } from "../src/exec/latency.ts";
import { Recorder, readRecording } from "../src/exec/recorder.ts";
import { deterministic, gridCells, linesToEvents, loadLines, parseRange, replayEvents, toCsv } from "../src/exec/replay.ts";
import { runAll, type Decision } from "../src/exec/strategies.ts";
import type { DepthEvent } from "../src/exec/types.ts";
import { build } from "./fixtures/genMini.ts";

const FIX = new URL("./fixtures/mini.ndjson", import.meta.url).pathname;
const strip = (e: DepthEvent[]) => e.map((x) => ({ ...x, depth: { ...x.depth, tick: undefined } }));

describe("replay", () => {
  test("committed fixture decodes to exactly the DepthEvents the generator intended", async () => {
    const { lines } = await loadLines(FIX);
    const events = linesToEvents(lines);
    const { events: wantRaw, lines: genLines } = build();
    const want = [...wantRaw].sort((a, b) => a.recvTs - b.recvTs);
    expect(lines.length).toBe(genLines.length); // fixture file is up to date with the generator
    expect(events.length).toBe(want.length);
    expect(strip(events)).toEqual(strip(want));
    // tick functions agree on the grid
    expect(events.at(-1)!.depth.tick(50)).toBe(want.at(-1)!.depth.tick(50));
    expect(events.find((e) => e.venue === "kalshi")!.depth.tick(5)).toBe(0.1);
    expect(events.find((e) => e.venue === "polymarket")!.depth.tick(50)).toBeCloseTo(1, 9);
  });

  test("episodes on the fixture: 5 episodes with the scripted lifetimes and killers", async () => {
    const { lines } = await loadLines(FIX);
    const r = replayEvents(linesToEvents(lines), { cells: gridCells([90], [6]), keepAttempts: true });
    expect(r.decisions).toBe(5);
    const tr = new EpisodeTracker();
    for (const e of linesToEvents(lines)) tr.onDepth(e);
    tr.closeAll(Number.MAX_SAFE_INTEGER);
    const eps = tr.closedEpisodes();
    expect(eps.map((e) => Math.round(e.durationMs! / 10) * 10)).toEqual([300, 80, 40, 1200, 500]);
    expect(eps.map((e) => e.killedBy)).toEqual(["poly", "kalshi", "poly", "poly", "poly"]);
    expect(r.episodes.survival.find((s) => s.ms === 100)!.share).toBeCloseTo(0.6, 5);
  });

  test("deterministic: two runs are identical", async () => {
    const { lines } = await loadLines(FIX);
    const ev = linesToEvents(lines);
    const cells = gridCells([5, 90, 300], [6, 50]);
    const a = replayEvents(ev, { cells, keepAttempts: true }), b = replayEvents(ev, { cells, keepAttempts: true });
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
    expect(JSON.stringify(a.cells)).toBe(JSON.stringify(b.cells));
  });

  test("monotone: slower Kalshi round trip never improves PAR FIRST-TRY both-fill (hedge retries can still catch up later)", async () => {
    const { lines } = await loadLines(FIX);
    const r = replayEvents(linesToEvents(lines), { cells: gridCells([5, 60, 300], [6]), keepAttempts: true });
    const both = (k: number) => r.attempts![`K${k}/P6`]!.filter((a) => a.strategy === "PAR" && a.outcome === "BOTH" && !a.retried).length;
    expect(both(5)).toBeGreaterThanOrEqual(both(60));
    expect(both(60)).toBeGreaterThanOrEqual(both(300));
    expect(both(5)).toBeGreaterThan(both(300));
    const naive = r.cells[0]!.strategies.find((s) => s.strategy === "NAIVE")!;
    expect(naive.bothRate).toBe(1);
  });

  test("replay with the live profile reproduces the live-sim result (within tolerance)", async () => {
    const { lines } = await loadLines(FIX);
    const events = linesToEvents(lines);
    const profile = deterministic(defaultProfile()); // "live profile", jitter-free so both paths draw identically
    const replay = replayEvents(events, { cells: [{ label: "live", kRtt: null, pRtt: null, profile }], keepAttempts: true, seed: 7 });

    // "live sim": full history available (decisions evaluated after the fact), driven straight from the hand-built DepthEvents
    const genEvents = build().events.sort((a, b) => a.recvTs - b.recvTs);
    const history = new BookHistory({ minutes: 20, maxEventsPerKey: 1e9, feedDelayMs: { kalshi: medianOf(profile.kalshi.feedDelay), polymarket: medianOf(profile.polymarket.feedDelay) } });
    const decisions: { d: Decision; seed: number }[] = [];
    let n = 0;
    const tr = new EpisodeTracker({ onStart: (s) => decisions.push({ seed: 7 * 100003 + ++n, d: { combo: s.episode.combo, qty: s.qty, decidedAt: s.episode.startRecv, kalshi: s.kalshi, poly: s.poly, source: "episode", tradeId: null } }) });
    for (const e of genEvents) { history.push(e); tr.onDepth(e); }
    const live = decisions.flatMap(({ d, seed }) => runAll(d, history, profile, { seed }));
    const got = replay.attempts!.live!;
    expect(got.length).toBe(live.length);
    let maxDiff = 0;
    for (let i = 0; i < live.length; i++) {
      expect(got[i]!.strategy).toBe(live[i]!.strategy);
      expect(got[i]!.outcome).toBe(live[i]!.outcome);
      maxDiff = Math.max(maxDiff, Math.abs((got[i]!.expPnlUsd ?? 0) - (live[i]!.expPnlUsd ?? 0)));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  test("record -> gzip -> replay pipeline end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-"));
    try {
      const rec = new Recorder({ dir, flushMs: 1e9 });
      for (const l of build().lines) rec.record(l.src, l.raw, l.venueTs); // recv/mono are re-stamped by the recorder: structure only
      await rec.close();
      const files = readdirSync(dir);
      expect(files.length).toBe(1);
      expect(files[0]!.endsWith(".gz")).toBe(true);
      expect((await readRecording(join(dir, files[0]!))).length).toBe(build().lines.length);
      const { lines } = await loadLines(dir);
      expect(lines.length).toBe(build().lines.length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("REST-coarse Kalshi polls (src kalshiRest) decode with bid-terms levels", () => {
    const ev = linesToEvents([{ v: 1, src: "kalshiRest", recv: 1e12, recvMono: 1, raw: JSON.stringify({ ticker: "KXT", yes: [[53, 7]], no: [[45, 9]] }) }]);
    expect(ev.length).toBe(1);
    expect(ev[0]!.depth.quality).toBe("rest-coarse");
    expect(ev[0]!.depth.up.asks).toEqual([{ price: 55, size: 9 }]);   // Up ask = 100 - NO bid
    expect(ev[0]!.depth.down.asks).toEqual([{ price: 47, size: 7 }]); // Down ask = 100 - YES bid
  });

  test("CSV grid and range parsing", async () => {
    expect(parseRange("5..300", 100)).toEqual([5, 105, 205, 300]);
    expect(parseRange("20,40")).toEqual([20, 40]);
    const g = parseRange("5..300");
    expect(g[0]).toBe(5); expect(g.at(-1)).toBe(300); expect(g.length).toBeGreaterThan(5);
    const { lines } = await loadLines(FIX);
    const ks = [5, 90], ps = [6, 30];
    const r = replayEvents(linesToEvents(lines), { cells: gridCells(ks, ps) });
    const csv = toCsv(r, ks, ps);
    expect(csv).toContain("# strategy=PAR metric=bothFillRate");
    expect(csv).toContain("kalshiRtt\\polyRtt,6,30");
    expect(csv).toContain("L_ms,share");
    const sec = csv.split("# strategy=PAR metric=bothFillRate\n")[1]!.split("\n");
    expect(sec[0]!.split(",").length).toBe(3);
    expect(sec[1]!.startsWith("5,")).toBe(true);
    expect(existsSync(FIX) && readFileSync(FIX, "utf8").length > 100).toBe(true);
  });
});
