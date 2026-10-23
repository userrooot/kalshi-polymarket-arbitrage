// Offline replay (`bun run replay`): recorded raw WS messages -> the SAME pure builders (KalshiBook, BookHistory,
// EpisodeTracker, runAll/fillSim) on a virtual clock (= recorded recv times). Every opportunity episode becomes a decision;
// it is evaluated once for EVERY latency cell of the Kalshi x Polymarket RTT grid with identical random draws, so cells
// differ only by latency. Output: CSV grids + JSON in data/replay-<ts>.{csv,json} (+ replay_runs row when a DB exists).
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { BookHistory } from "./bookHistory.ts";
import { EpisodeTracker, SURVIVAL_MS, type StartInfo } from "./episodes.ts";
import { execOptsFromConfig, type ExecOpts } from "./fillSim.ts";
import { defaultProfile, loadProfile, medianOf, withRtt } from "./latency.ts";
import { listRecordings, readRecording, type RecordLine } from "./recorder.ts";
import { DepthAdapter, type AdapterOpts } from "./replayAdapters.ts";
import { STRATEGIES, runAll, strategyStats, type Decision } from "./strategies.ts";
import type { AttemptResult, DepthEvent, LatencyProfile, StrategyId, StrategyStats } from "./types.ts";

export interface Cell { label: string; kRtt: number | null; pRtt: number | null; profile: LatencyProfile }
export interface CellResult { label: string; kRtt: number | null; pRtt: number | null; strategies: StrategyStats[] }
export interface ReplayResult {
  generatedAt: string; files: string[]; events: number; decisions: number;
  episodes: { total: number; open: number; durationMs: ReturnType<EpisodeTracker["durationDist"]>; survival: ReturnType<EpisodeTracker["survival"]>; killedBy: Record<string, number>; censored: number };
  cells: CellResult[];
}
export interface ReplayOpts {
  cells: Cell[];
  feedDelayMs?: { kalshi?: number; polymarket?: number };
  n?: number; maxTotalCost?: number; seed?: number;
  exec?: Partial<ExecOpts>;
  /** keep every attempt per cell (tests / debugging) */
  keepAttempts?: boolean;
}
export interface ReplayRun extends ReplayResult { attempts?: Record<string, AttemptResult[]> }

/** Run the recorded DepthEvents (recv-time order) through the engine for all cells. Deterministic. */
export function replayEvents(events: DepthEvent[], o: ReplayOpts): ReplayRun {
  const base = defaultProfile();
  const history = new BookHistory({ minutes: 20, maxEventsPerKey: 1e9, feedDelayMs: o.feedDelayMs ?? { kalshi: medianOf(base.kalshi.feedDelay), polymarket: medianOf(base.polymarket.feedDelay) } });
  const exec = execOptsFromConfig(o.exec);
  const maxRtt = Math.max(0, ...o.cells.flatMap((c) => [c.kRtt ?? 0, c.pRtt ?? 0]));
  // A decision is evaluated once the clock passed everything its attempt can still look at: send, retry, unwind, secondsDelay.
  const horizon = 1500 + exec.unwindAfterMs + 4 * maxRtt + Math.max(0, ...o.cells.flatMap((c) => [c.profile.kalshi.secondsDelayMs ?? 0, c.profile.polymarket.secondsDelayMs ?? 0]));
  const pending: { d: Decision; seed: number }[] = [];
  const results: Record<string, AttemptResult[]> = Object.fromEntries(o.cells.map((c) => [c.label, [] as AttemptResult[]]));
  let nDec = 0, seedN = 0;
  const tracker = new EpisodeTracker({
    n: o.n, maxTotalCost: o.maxTotalCost,
    onStart: (s: StartInfo) => {
      nDec++;
      pending.push({ seed: (o.seed ?? 1) * 100003 + ++seedN, d: { combo: s.episode.combo, qty: s.qty, decidedAt: s.episode.startRecv, kalshi: s.kalshi, poly: s.poly, source: "episode", tradeId: null } });
    },
  });
  const evaluate = (p: { d: Decision; seed: number }) => {
    for (const c of o.cells) results[c.label]!.push(...runAll(p.d, history, c.profile, { ...o.exec, seed: p.seed }));
  };
  for (const ev of events) {
    history.push(ev);
    tracker.onDepth(ev);
    while (pending.length && ev.recvTs >= pending[0]!.d.decidedAt + horizon) evaluate(pending.shift()!);
  }
  for (const p of pending.splice(0)) evaluate(p);
  const last = events[events.length - 1];
  if (last) tracker.closeAll(last.recvTs);
  const eps = tracker.closedEpisodes();
  const cells: CellResult[] = o.cells.map((c) => ({
    label: c.label, kRtt: c.kRtt, pRtt: c.pRtt,
    strategies: STRATEGIES.map((s) => strategyStats(results[c.label]!, s)),
  }));
  return {
    generatedAt: new Date().toISOString(), files: [], events: events.length, decisions: nDec,
    episodes: {
      total: tracker.total(), open: 0, durationMs: tracker.durationDist(), survival: tracker.survival(SURVIVAL_MS), killedBy: tracker.summary().killedBy,
      censored: eps.filter((e) => e.censored).length,
    },
    cells, ...(o.keepAttempts ? { attempts: results } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ loading
export async function loadLines(pathOrDir: string): Promise<{ files: string[]; lines: RecordLine[] }> {
  const files = listRecordings(pathOrDir);
  const lines: RecordLine[] = [];
  for (const f of files) for (const l of await readRecording(f)) lines.push(l);
  // Files are chronological; within a file lines are in receive order. A stable sort by recv merges restart overlaps.
  lines.sort((a, b) => a.recv - b.recv);
  return { files, lines };
}
export function linesToEvents(lines: RecordLine[], ao: AdapterOpts = {}): DepthEvent[] {
  const a = new DepthAdapter(ao);
  const out: DepthEvent[] = [];
  for (const l of lines) for (const e of a.push(l)) out.push(e);
  return out;
}

// ------------------------------------------------------------------------------------------------ grid / profiles
/** "5..300" -> [5,...,300]; with step: linear; without: 9 geometric-ish points. "5,20,100" lists also accepted. */
export function parseRange(spec: string, step?: number): number[] {
  if (spec.includes(",")) return spec.split(",").map(Number).filter(Number.isFinite);
  const m = /^(\d+(?:\.\d+)?)(?:\.\.(\d+(?:\.\d+)?))?$/.exec(spec.trim());
  if (!m) throw new Error(`bad range '${spec}' (use a..b or a,b,c)`);
  const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
  if (a === b) return [a];
  if (step && step > 0) { const out: number[] = []; for (let x = a; x < b - 1e-9; x += step) out.push(Math.round(x * 100) / 100); out.push(b); return out; }
  const N = 9, out = new Set<number>();
  for (let i = 0; i < N; i++) out.add(Math.round(a * (b / a) ** (i / (N - 1))));
  return [...out].sort((x, y) => x - y);
}
/** Deterministic copy of a profile: every component becomes lognormal(median, sigma 0). */
export function deterministic(p: LatencyProfile): LatencyProfile {
  const f = (c: any) => ({ kind: "lognormal" as const, medianMs: medianOf(c), sigma: 0 });
  const v = (x: LatencyProfile["kalshi"]) => ({ ...x, feedDelay: f(x.feedDelay), sendOneWay: f(x.sendOneWay), process: f(x.process), ackOneWay: f(x.ackOneWay) });
  return { ...p, kalshi: v(p.kalshi), polymarket: v(p.polymarket) };
}
export function gridCells(ks: number[], ps: number[], base: LatencyProfile = defaultProfile()): Cell[] {
  const det = deterministic(base);
  return ks.flatMap((k) => ps.map((p) => ({ label: `K${k}/P${p}`, kRtt: k, pRtt: p, profile: withRtt(withRtt(det, "kalshi", k, 0), "polymarket", p, 0) })));
}

// ------------------------------------------------------------------------------------------------ output
export function toCsv(r: ReplayResult, ks: number[], ps: number[]): string {
  const out: string[] = [];
  const cell = (k: number, p: number) => r.cells.find((c) => c.kRtt === k && c.pRtt === p);
  out.push(`# replay generated ${r.generatedAt}; files=${r.files.length} events=${r.events} decisions=${r.decisions}`);
  out.push(`# rows: Kalshi RTT ms, columns: Polymarket RTT ms. Simulation estimates, not guarantees.`);
  const metrics: { name: string; get: (s: StrategyStats) => number }[] = [
    { name: "bothFillRate", get: (s) => s.bothRate }, { name: "expPnlPerAttemptUsd", get: (s) => s.expPnlPerAttemptUsd },
  ];
  for (const st of STRATEGIES) for (const m of metrics) {
    out.push("", `# strategy=${st} metric=${m.name}`, ["kalshiRtt\\polyRtt", ...ps].join(","));
    for (const k of ks) out.push([k, ...ps.map((p) => { const s = cell(k, p)?.strategies.find((x) => x.strategy === st); return s ? m.get(s) : ""; })].join(","));
  }
  out.push("", "# episode lifetime summary", "metric,value");
  const d = r.episodes.durationMs;
  out.push(`episodes,${r.episodes.total}`, `censored,${r.episodes.censored}`, `duration_n,${d.n}`, `duration_p50_ms,${d.p50 ?? ""}`, `duration_p95_ms,${d.p95 ?? ""}`, `duration_p99_ms,${d.p99 ?? ""}`, `duration_mean_ms,${d.mean ?? ""}`);
  for (const [k, v] of Object.entries(r.episodes.killedBy)) out.push(`killedBy_${k},${v}`);
  out.push("", "# survival: share of episodes lasting longer than L ms", "L_ms,share");
  for (const s of r.episodes.survival) out.push(`${s.ms},${s.share}`);
  return out.join("\n") + "\n";
}

function saveRun(r: ReplayResult, params: unknown, csvPath: string) {
  const path = config.dbPath;
  if (path !== ":memory:" && !existsSync(path)) return false;
  try {
    const db = new Database(path);
    db.run("CREATE TABLE IF NOT EXISTS replay_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, params TEXT NOT NULL, csv_path TEXT, data TEXT NOT NULL)");
    db.query("INSERT INTO replay_runs (ts,params,csv_path,data) VALUES (?,?,?,?)").run(Date.now(), JSON.stringify(params), csvPath, JSON.stringify(r));
    db.close();
    return true;
  } catch (e) { console.error("[replay] db write failed:", (e as Error).message); return false; }
}

// ------------------------------------------------------------------------------------------------ CLI
export interface CliArgs { input: string; latK: string; latP: string; step?: number; outDir: string; seed: number; db: boolean }
export function parseArgs(argv: string[]): CliArgs {
  const get = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const step = get("--step");
  return {
    input: get("--file") ?? get("--dir") ?? get("--in") ?? process.env.MD_DIR ?? "data/md",
    latK: get("--lat-k") ?? "5..300", latP: get("--lat-p") ?? "5..50",
    step: step ? Number(step) : undefined, outDir: get("--out") ?? "data", seed: Number(get("--seed")) || 1, db: !argv.includes("--no-db"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!existsSync(a.input)) { console.error(`[replay] no such file or directory: ${a.input} (record with RECORD_MD=1 first)`); process.exit(1); }
  const { files, lines } = await loadLines(a.input);
  const ks = parseRange(a.latK, a.step), ps = parseRange(a.latP, a.step);
  console.log(`[replay] ${files.length} file(s), ${lines.length} messages; grid ${ks.length}x${ps.length} (Kalshi ${ks.join(",")} / Polymarket ${ps.join(",")} ms RTT)`);
  const events = linesToEvents(lines);
  const sources = new Set(lines.map((l) => l.src));
  console.log(`[replay] sources: ${[...sources].join(", ")}; depth events: ${events.length} (kalshi ${events.filter((e) => e.venue === "kalshi").length}, polymarket ${events.filter((e) => e.venue === "polymarket").length})`);
  if (!events.some((e) => e.venue === "kalshi") || !events.some((e) => e.venue === "polymarket"))
    console.warn("[replay] WARNING: need depth from BOTH venues to form episodes (Kalshi WS book needs KALSHI_API_KEY_ID; REST polls are not recorded).");
  const base = loadProfile();
  const t0 = performance.now();
  const r = replayEvents(events, { cells: gridCells(ks, ps, base), seed: a.seed });
  r.files = files;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  mkdirSync(a.outDir, { recursive: true });
  const csvPath = `${a.outDir}/replay-${stamp}.csv`, jsonPath = `${a.outDir}/replay-${stamp}.json`;
  writeFileSync(csvPath, toCsv(r, ks, ps));
  writeFileSync(jsonPath, JSON.stringify({ ...r, params: { ...a, ks, ps, profileSource: base.source } }));
  if (a.db && saveRun(r, { ...a, ks, ps }, csvPath)) console.log("[replay] saved to replay_runs");
  console.log(`[replay] ${r.decisions} decisions, ${r.episodes.total} episodes (${r.episodes.censored} censored) in ${Math.round(performance.now() - t0)}ms -> ${csvPath}, ${jsonPath}`);
  const d = r.episodes.durationMs;
  console.log(`[replay] episode lifetime p50=${d.p50 ?? "-"}ms p95=${d.p95 ?? "-"}ms; survival ` + r.episodes.survival.map((s) => `>${s.ms}ms:${s.share}`).join(" "));
  const mid = r.cells[Math.floor(r.cells.length / 2)];
  if (mid) console.log(`[replay] e.g. ${mid.label}: ` + mid.strategies.map((s) => `${s.strategy} both=${s.bothRate} pnl/att=${s.expPnlPerAttemptUsd}`).join(" | "));
}
if (import.meta.main) main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
