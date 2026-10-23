import { describe, expect, test } from "bun:test";
import { EpisodeTracker, evalCombo } from "../src/exec/episodes.ts";
import type { Episode } from "../src/exec/types.ts";
import { K, P, ev } from "./execHelpers.ts";

const mk = (extra: ConstructorParameters<typeof EpisodeTracker>[0] = {}) => {
  const saved: Episode[] = [], starts: number[] = [];
  const t = new EpisodeTracker({ n: 10, maxTotalCost: 90, staleMs: 3000, persist: (e) => saved.push({ ...e }), onStart: (s) => starts.push(s.episode.id), ...extra });
  return { t, saved, starts };
};
// Kalshi Up ask ka (size ks) + Polymarket Down ask pa (size ps); the other combo is never attractive.
const kEv = (t: number, ka: number, ks = 1000, venueTs: number | null = null, key = K) => ev("kalshi", key, t, { upAsks: [[ka, ks]], downAsks: [[99, 1000]] }, venueTs);
const pEv = (t: number, pa: number, ps = 1000, venueTs: number | null = null, key = P) => ev("polymarket", key, t, { downAsks: [[pa, ps]], upAsks: [[99, 1000]] }, venueTs);

describe("EpisodeTracker", () => {
  test("starts below MAX_TOTAL_COST, tracks max edge, ends when the Kalshi price moves (killedBy kalshi / price_moved)", () => {
    const { t, saved, starts } = mk();
    t.onDepth(kEv(0, 50)); t.onDepth(pEv(1, 38)); // 88 < 90 -> start at t=1
    expect(starts).toHaveLength(1); expect(t.openEpisodes()).toHaveLength(1);
    t.onDepth(kEv(10, 48)); // better: 86
    t.onDepth(kEv(31, 55)); // 93 -> dies
    expect(t.openEpisodes()).toHaveLength(0);
    const e = t.closedEpisodes()[0]!;
    expect(e.combo).toBe("K_UP+P_DOWN");
    expect(e.durationMs).toBe(30); expect(e.startRecv).toBe(1); expect(e.endRecv).toBe(31);
    expect(e.maxEdgeCents).toBe(14); expect(e.maxSize).toBeGreaterThanOrEqual(10);
    expect(e.killedBy).toBe("kalshi"); expect(e.killReason).toBe("price_moved"); expect(e.censored).toBe(false);
    expect(saved).toHaveLength(1);
  });
  test("strict threshold: cost == MAX_TOTAL_COST is not an episode", () => {
    const { t } = mk();
    t.onDepth(kEv(0, 50)); t.onDepth(pEv(1, 40));
    expect(t.total()).toBe(0);
    t.onDepth(pEv(2, 39.9));
    expect(t.total()).toBe(1);
  });
  test("depth consumed: same best price but the size disappears; killedBy poly", () => {
    const { t } = mk();
    t.onDepth(kEv(0, 50)); t.onDepth(pEv(1, 38, 1000));
    t.onDepth(pEv(20, 38, 4)); // only 4 shares left at 38, none behind -> cannot buy 10
    const e = t.closedEpisodes()[0]!;
    expect(e.killedBy).toBe("poly"); expect(e.killReason).toBe("depth_consumed"); expect(e.durationMs).toBe(19);
  });
  test("walks depth: a cheap but thin best level does not make an episode; enough depth at a worse price may still qualify", () => {
    expect(evalCombo([{ price: 40, size: 3 }, { price: 60, size: 100 }], [{ price: 40, size: 100 }], 10, 90).ok).toBe(false); // vwap 54
    expect(evalCombo([{ price: 40, size: 6 }, { price: 45, size: 100 }], [{ price: 40, size: 100 }], 10, 90).ok).toBe(true);    // vwap 42
    const e = evalCombo([{ price: 40, size: 6 }, { price: 45, size: 100 }, { price: 70, size: 100 }], [{ price: 40, size: 100 }], 10, 90);
    expect(e.maxSize).toBeGreaterThan(10); expect(e.maxSize).toBeLessThan(106);
    expect(evalCombo([{ price: 40, size: 100 }], [{ price: 40, size: 100 }], 3, 90, 0.01, 5).ok).toBe(false); // below Polymarket min order size
  });
  test("killedBy both: the other venue's update within 1ms would also have killed it", () => {
    const { t } = mk();
    t.onDepth(kEv(0, 50)); t.onDepth(pEv(1, 38));
    t.onDepth(kEv(100, 60));        // kills (kalshi)
    t.onDepth(pEv(100.5, 60));      // 0.5ms later poly also moves away
    expect(t.closedEpisodes()[0]!.killedBy).toBe("both");
    expect(t.summary().killedBy.both).toBe(1);
    expect(t.summary().killedBy.kalshi ?? 0).toBe(0);
    // ...but not if the other venue's move comes later
    const b = mk();
    b.t.onDepth(kEv(0, 50)); b.t.onDepth(pEv(1, 38)); b.t.onDepth(kEv(100, 60)); b.t.onDepth(pEv(105, 60));
    expect(b.t.closedEpisodes()[0]!.killedBy).toBe("kalshi");
  });
  test("feed gap closes the episode as stale/censored (on the next event and via sweep)", () => {
    const { t } = mk();
    t.onDepth(kEv(0, 50)); t.onDepth(pEv(1, 38));
    t.onDepth(pEv(5000, 38)); // Kalshi silent for 5s
    const e = t.closedEpisodes()[0]!;
    expect(e.killedBy).toBe("stale"); expect(e.killReason).toBe("stale"); expect(e.censored).toBe(true); expect(e.endRecv).toBe(1);
    const s = mk();
    s.t.onDepth(kEv(0, 50)); s.t.onDepth(pEv(1, 38));
    s.t.sweep(2000); expect(s.t.openEpisodes()).toHaveLength(1);
    s.t.sweep(4500); expect(s.t.openEpisodes()).toHaveLength(0);
    expect(s.t.closedEpisodes()[0]!.censored).toBe(true);
  });
  test("window rollover closes episodes as censored and does not pair across windows", () => {
    const { t } = mk();
    t.onDepth({ ...kEv(0, 50), closeMs: 900_000 }); t.onDepth({ ...pEv(1, 38), closeMs: 900_000 });
    expect(t.openEpisodes()).toHaveLength(1);
    t.onDepth({ ...kEv(500, 50, 1000, null, "K-NEXT"), closeMs: 1_800_000 });
    const e = t.closedEpisodes()[0]!;
    expect(e.killedBy).toBe("rollover"); expect(e.killReason).toBe("rollover"); expect(e.censored).toBe(true);
    expect(t.openEpisodes()).toHaveLength(0); // poly still on the old window: windows disagree -> no new episode
    t.onDepth({ ...pEv(510, 38, 1000, null, "P-NEXT"), closeMs: 1_800_000 });
    expect(t.openEpisodes()).toHaveLength(1);
  });
  test("survival curve and duration distribution (censored handled)", () => {
    const { t } = mk();
    let now = 0;
    const episode = (dur: number) => { t.onDepth(kEv(now, 50)); t.onDepth(pEv(now + 1, 38)); t.onDepth(kEv(now + 1 + dur, 60)); now += 10_000; t.onDepth(kEv(now, 60)); t.onDepth(pEv(now, 38)); };
    for (const d of [3, 12, 60, 250, 700]) episode(d);
    const sv = Object.fromEntries(t.survival().map((p) => [p.ms, p.share]));
    expect(sv[5]).toBeCloseTo(0.8); expect(sv[10]).toBeCloseTo(0.8); expect(sv[20]).toBeCloseTo(0.6);
    expect(sv[100]).toBeCloseTo(0.4); expect(sv[300]).toBeCloseTo(0.2); expect(sv[500]).toBeCloseTo(0.2);
    const d = t.durationDist();
    expect(d.n).toBe(5); expect(d.p50).toBeGreaterThanOrEqual(60); expect(d.p50).toBeLessThanOrEqual(61);
    expect(t.summary().recent.length).toBe(5);
  });
});
