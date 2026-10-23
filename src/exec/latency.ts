// Latency profile: defaults, LAT_PROFILE file (written by `bun run probe`), what-if overrides, and seedable sampling.
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";
import type { LatencyComponent, LatencyProfile, VenueLatency } from "./types.ts";

/** Deterministic PRNG (mulberry32): the same seed always yields the same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ln = (medianMs: number, sigma: number): LatencyComponent => ({ kind: "lognormal", medianMs, sigma });

/** UK server defaults. Polymarket RTT ~6ms (one way ~3ms), Kalshi (Ohio) RTT ~90ms (one way ~45ms). Guesses until `bun run probe` measures them. */
export function defaultProfile(): LatencyProfile {
  return {
    source: "default",
    polymarket: { feedDelay: ln(4, 0.5), sendOneWay: ln(3, 0.5), process: ln(1.5, 0.4), ackOneWay: ln(3, 0.5) },
    kalshi: { feedDelay: ln(45, 0.4), sendOneWay: ln(45, 0.4), process: ln(5, 0.4), ackOneWay: ln(45, 0.4) },
  };
}
export const defaultLatencyProfile = defaultProfile;

const validComp = (c: any): c is LatencyComponent =>
  c && (c.kind === "lognormal" ? Number.isFinite(c.medianMs) : c.kind === "empirical" && Array.isArray(c.samples) && c.samples.length > 0);

/** Merge a (possibly partial) profile over the defaults. */
export function mergeProfile(over: any, base = defaultProfile()): LatencyProfile {
  const out: LatencyProfile = { ...base, kalshi: { ...base.kalshi }, polymarket: { ...base.polymarket } };
  for (const v of ["kalshi", "polymarket"] as const)
    for (const c of ["feedDelay", "sendOneWay", "process", "ackOneWay"] as const)
      if (validComp(over?.[v]?.[c])) out[v][c] = over[v][c];
  for (const v of ["kalshi", "polymarket"] as const)
    if (Number.isFinite(over?.[v]?.secondsDelayMs)) out[v].secondsDelayMs = over[v].secondsDelayMs;
  if (over?.source === "probe" || over?.source === "override") out.source = over.source;
  return out;
}

/** What-if: set a venue's ROUND TRIP (ms): send and ack one-way each become rtt/2 (keeps the other components). */
export function withRtt(p: LatencyProfile, venue: "kalshi" | "polymarket", rttMs: number, sigma?: number): LatencyProfile {
  const v: VenueLatency = { ...p[venue] };
  const keepSigma = (c: LatencyComponent) => sigma ?? (c.kind === "lognormal" ? c.sigma ?? 0.4 : 0.4);
  v.sendOneWay = ln(rttMs / 2, keepSigma(p[venue].sendOneWay));
  v.ackOneWay = ln(rttMs / 2, keepSigma(p[venue].ackOneWay));
  return { ...p, [venue]: v, source: "override" };
}
/** Fully deterministic profile (sigma 0) with the given RTTs; used by the live latency sweep and by tests. */
export function fixedProfile(kalshiRttMs: number, polyRttMs: number, feedK = 0, feedP = 0, processMs = 0): LatencyProfile {
  const f = (m: number) => ln(m, 0);
  return {
    source: "override",
    kalshi: { feedDelay: f(feedK), sendOneWay: f(kalshiRttMs / 2), process: f(processMs), ackOneWay: f(kalshiRttMs / 2) },
    polymarket: { feedDelay: f(feedP), sendOneWay: f(polyRttMs / 2), process: f(processMs), ackOneWay: f(polyRttMs / 2) },
  };
}

/** Load LAT_PROFILE (default data/latency.json) else defaults; then apply LAT_KALSHI_MS / LAT_POLY_MS (RTT) overrides. Never throws. */
export function loadProfile(path = config.latProfile, env: { LAT_KALSHI_MS?: number; LAT_POLY_MS?: number } = { LAT_KALSHI_MS: config.latKalshiMs, LAT_POLY_MS: config.latPolyMs }): LatencyProfile {
  let p = defaultProfile();
  try {
    if (path && existsSync(path)) {
      const j = JSON.parse(readFileSync(path, "utf8"));
      p = mergeProfile(j);
      if (p.source === "default") p.source = "probe";
    }
  } catch (e) { console.error(`[latency] cannot read ${path}: ${(e as Error).message}; using defaults`); }
  if (Number.isFinite(env.LAT_KALSHI_MS)) p = withRtt(p, "kalshi", env.LAT_KALSHI_MS!);
  if (Number.isFinite(env.LAT_POLY_MS)) p = withRtt(p, "polymarket", env.LAT_POLY_MS!);
  return p;
}

function normal(rng: () => number): number {
  const u = Math.max(1e-12, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
/** Draw one sample (ms, >= 0). Lognormal: median * exp(sigma * Z). Empirical: bootstrap (uniform pick). Always consumes the same number of rng draws per kind. */
export function sample(c: LatencyComponent, rng: () => number): number {
  if (c.kind === "empirical") {
    const s = c.samples ?? [];
    const u = rng(); rng();
    return s.length ? Math.max(0, s[Math.min(s.length - 1, Math.floor(u * s.length))]!) : 0;
  }
  return Math.max(0, (c.medianMs ?? 0) * Math.exp((c.sigma ?? 0) * normal(rng)));
}
/** Median of a component (used for what we "know" about the feed delay). */
export function medianOf(c: LatencyComponent): number {
  if (c.kind === "empirical") { const s = [...(c.samples ?? [])].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : 0; }
  return c.medianMs ?? 0;
}

/** One set of sampled latencies for one venue leg (+ one for its hedge retry). Shared by all strategies of a decision. */
export interface LegSamples { sendMs: number; processMs: number; ackMs: number; feedMs: number; raceU: number }
export interface AttemptSamples { kalshi: LegSamples; poly: LegSamples; kalshiRetry: LegSamples; polyRetry: LegSamples }

export function sampleLeg(v: VenueLatency, rng: () => number): LegSamples {
  return { sendMs: sample(v.sendOneWay, rng), processMs: sample(v.process, rng), ackMs: sample(v.ackOneWay, rng), feedMs: sample(v.feedDelay, rng), raceU: rng() };
}
export function sampleAttempt(p: LatencyProfile, rng: () => number): AttemptSamples {
  return { kalshi: sampleLeg(p.kalshi, rng), poly: sampleLeg(p.polymarket, rng), kalshiRetry: sampleLeg(p.kalshi, rng), polyRetry: sampleLeg(p.polymarket, rng) };
}
