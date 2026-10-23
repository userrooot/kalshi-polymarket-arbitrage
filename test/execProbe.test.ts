import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIRM_PHRASE, NotImplementedError, buildProfile, capSamples, checkLiveGates, emptyMeasurements, fallbackProfile, placePolyFokProbe,
  polyL2Headers, runLiveCalibration, summarize, writeLatencyJson, wsRtt, type ProbeDeps, type WSLike,
} from "../src/exec/probe.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const mkDeps = (env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch): ProbeDeps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (url: any) => { calls.push(String(url)); return fetchImpl ? fetchImpl(url) : new Response("{}", { status: 200 }); }) as typeof fetch,
    now: () => performance.now(), sleep: async () => {}, wsFactory: () => { throw new Error("no network in tests"); },
    env, chrony: async () => null, log: () => {},
  };
};

describe("latency.json writer", () => {
  test("shape matches LatencyProfile and caps samples", () => {
    const m = emptyMeasurements();
    m.polyWsRtt = Array.from({ length: 5000 }, (_, i) => 5 + (i % 7));
    m.kalshiWsRtt = Array.from({ length: 20 }, (_, i) => 80 + i);
    const profile = buildProfile(m);
    expect(profile.source).toBe("probe");
    const dir = mkdtempSync(join(tmpdir(), "lat-")); dirs.push(dir);
    const path = join(dir, "sub", "latency.json");
    writeLatencyJson(path, profile, { generatedAt: "x", host: "h", clockOffsetMs: null, chrony: null, measurements: { polyWsRtt: summarize(m.polyWsRtt) }, notes: [], unverified: [], demo: null });
    const j = JSON.parse(readFileSync(path, "utf8"));
    for (const v of ["kalshi", "polymarket"]) for (const c of ["feedDelay", "sendOneWay", "process", "ackOneWay"]) {
      expect(["lognormal", "empirical"]).toContain(j[v][c].kind);
    }
    expect(j.polymarket.sendOneWay.kind).toBe("empirical");
    expect(j.polymarket.sendOneWay.samples.length).toBe(2000);
    expect(j.kalshi.sendOneWay.samples.length).toBe(20);
    expect(j.kalshi.sendOneWay.samples[0]).toBeCloseTo(40, 5); // RTT/2
    expect(j.kalshi.feedDelay).toEqual(fallbackProfile().kalshi.feedDelay); // unmeasured components keep defaults
    expect(j.meta.generatedAt).toBe("x");
    expect(capSamples([1, 2, 3], 2).length).toBe(2);
  });
  test("too few samples keep the default component", () => {
    const m = emptyMeasurements(); m.polyWsRtt = [4, 5];
    expect(buildProfile(m).polymarket.sendOneWay).toEqual(fallbackProfile().polymarket.sendOneWay);
  });
});

describe("live calibration gates", () => {
  test("gate function needs all three", () => {
    expect(checkLiveGates({ env: {}, argv: [], typed: null }).missing.length).toBe(3);
    expect(checkLiveGates({ env: { CALIBRATE_LIVE: "1" }, argv: ["--live"], typed: "i understand" }).ok).toBe(false);
    expect(checkLiveGates({ env: { CALIBRATE_LIVE: "1" }, argv: ["--live"], typed: CONFIRM_PHRASE }).ok).toBe(true);
  });
  test("refuses without env/flag before any network or prompt", async () => {
    let asked = false;
    const deps = mkDeps({});
    const r = await runLiveCalibration({ deps, argv: [], ask: async () => { asked = true; return CONFIRM_PHRASE; } });
    expect(r.refused).toEqual(["CALIBRATE_LIVE=1", "--live flag"]);
    expect(asked).toBe(false);
    expect(deps.calls.length).toBe(0);
    const r2 = await runLiveCalibration({ deps: mkDeps({ CALIBRATE_LIVE: "1" }), argv: ["--live"], ask: async () => { asked = true; return "yes"; } });
    expect(asked).toBe(true);
    expect(r2.refused.length).toBe(1);
    expect(r2.kalshi.length).toBe(0);
  });
  test("wrong typed phrase makes no requests", async () => {
    const deps = mkDeps({ CALIBRATE_LIVE: "1" });
    const r = await runLiveCalibration({ deps, argv: ["--live"], ask: async () => "I UNDERSTAND" });
    expect(r.refused[0]).toContain("typed confirmation");
    expect(deps.calls.length).toBe(0);
  });
  test("Polymarket order placement is a stub that throws", async () => {
    await expect(placePolyFokProbe("1")).rejects.toThrow(/not implemented/);
    await expect(placePolyFokProbe("1")).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe("polymarket L2 signing + ws rtt", () => {
  test("HMAC recipe matches independent computation", () => {
    const secret = Buffer.from("super-secret-bytes").toString("base64");
    const h = polyL2Headers({ apiKey: "k", secret, passphrase: "p", address: "0xabc" }, "get", "/data/orders", "", 1700000000);
    const expected = createHmac("sha256", Buffer.from(secret, "base64")).update("1700000000GET/data/orders").digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
    expect(h.POLY_SIGNATURE).toBe(expected);
    expect(h).toMatchObject({ POLY_ADDRESS: "0xabc", POLY_TIMESTAMP: "1700000000", POLY_API_KEY: "k", POLY_PASSPHRASE: "p" });
  });
  test("wsRtt with a mock socket", async () => {
    class Mock implements WSLike {
      onopen: any = null; onmessage: any = null; onerror: any = null; onclose: any = null;
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      send(s: string) { if (s === "PING") setTimeout(() => this.onmessage?.({ data: "PONG" }), 2); }
      close() {}
    }
    const deps = { ...mkDeps(), wsFactory: () => new Mock(), sleep: async () => {}, now: () => performance.now() };
    const r = await wsRtt(deps, "ws://x", { n: 4, gapMs: 0, makePing: () => "PING", isReply: (s) => s === "PONG" });
    expect(r.length).toBe(3); // first sample dropped as warm-up
    expect(r.every((x) => x >= 0)).toBe(true);
  });
});
