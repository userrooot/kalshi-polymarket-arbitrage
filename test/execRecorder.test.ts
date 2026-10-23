import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Recorder, hourName, listRecordings, readRecording, sniffVenueTs } from "../src/exec/recorder.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rec-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("recorder", () => {
  test("writes NDJSON lines with both timestamps and round-trips through gzip", async () => {
    const dir = tmp();
    const rec = new Recorder({ dir, flushMs: 20 });
    rec.record("polyBook", JSON.stringify({ event_type: "book", timestamp: "1750000000123", asset_id: "x" }));
    rec.record("kalshiBook(ws)", JSON.stringify({ type: "orderbook_delta", msg: { ts_ms: 1750000000456 } }));
    rec.record("polyLive", "raw-not-json");
    await rec.idle();
    const live = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
    expect(live.length).toBe(1);
    const lines = await readRecording(join(dir, live[0]!));
    expect(lines.length).toBe(3);
    expect(lines[0]).toMatchObject({ v: 1, src: "polyBook", venueTs: 1750000000123 });
    expect(lines[1]!.venueTs).toBe(1750000000456);
    expect(lines[2]!.venueTs).toBeUndefined();
    expect(lines[0]!.recv).toBeGreaterThan(1.6e12);
    expect(lines[0]!.recvMono).toBeGreaterThan(0);
    expect(rec.stats().msgs).toBe(3);
    await rec.close();
    const gz = readdirSync(dir);
    expect(gz.length).toBe(1);
    expect(gz[0]!.endsWith(".ndjson.gz")).toBe(true);
    const back = await readRecording(join(dir, gz[0]!));
    expect(back.map((l) => l.raw)).toEqual(lines.map((l) => l.raw));
  });

  test("rotates hourly, gzips the closed file and keeps ordering", async () => {
    const dir = tmp();
    let t = Date.UTC(2026, 0, 2, 3, 59, 59);
    const rec = new Recorder({ dir, flushMs: 1e9, now: () => new Date(t) });
    rec.record("a", "{\"n\":1}");
    await rec.flush();
    t += 2000; // 04:00:01
    rec.record("a", "{\"n\":2}");
    await rec.idle();
    expect(readdirSync(dir).sort()).toEqual(["20260102-03.ndjson.gz", "20260102-04.ndjson"]);
    expect(hourName(new Date(t))).toBe("20260102-04");
    const all: string[] = [];
    for (const f of listRecordings(dir)) for (const l of await readRecording(f)) all.push(l.raw);
    expect(all).toEqual(["{\"n\":1}", "{\"n\":2}"]);
    await rec.close();
  });

  test("retention deletes oldest files first and never the current one", async () => {
    const dir = tmp();
    const t = Date.UTC(2026, 0, 2, 5, 0, 0);
    for (const h of ["01", "02", "03"]) writeFileSync(join(dir, `20260102-${h}.ndjson.gz`), Buffer.alloc(1000, 1));
    const rec = new Recorder({ dir, flushMs: 1e9, retentionGB: 2500 / 1e9, now: () => new Date(t) });
    rec.record("a", "x".repeat(10));
    await rec.idle();
    rec.enforceRetention(); // (also ran during the flush)
    const left = readdirSync(dir).sort();
    expect(left).not.toContain("20260102-01.ndjson.gz");
    expect(left).toContain("20260102-05.ndjson");
    expect(left.reduce((a, f) => a + statSync(join(dir, f)).size, 0)).toBeLessThanOrEqual(2500);
    await rec.close();
  });

  test("compresses stale uncompressed files left by a previous run", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "20200101-00.ndjson"), JSON.stringify({ v: 1, src: "a", recv: 1, recvMono: 1, raw: "z" }) + "\n");
    const rec = new Recorder({ dir, flushMs: 1e9 });
    await rec.idle();
    expect(existsSync(join(dir, "20200101-00.ndjson.gz"))).toBe(true);
    expect(existsSync(join(dir, "20200101-00.ndjson"))).toBe(false);
    await rec.close();
  });

  test("sniffVenueTs handles poly ms, kalshi ts_ms and kalshi seconds", () => {
    expect(sniffVenueTs('{"timestamp":"1750000000123"}')).toBe(1750000000123);
    expect(sniffVenueTs('{"msg":{"ts":1750000000}}')).toBe(1750000000000);
    expect(sniffVenueTs("{}")).toBeUndefined();
  });
});
