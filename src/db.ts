import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { Trade } from "./types.ts";

let _db: Database | null = null;
/** Opened lazily so modules that import db.ts (and their unit tests) don't create the file until it is used. */
function db(): Database {
  if (_db) return _db;
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const d = new Database(config.dbPath, { create: true });
  d.run("PRAGMA journal_mode=WAL");
  // WAL + NORMAL: no fsync per INSERT (episode rows are written synchronously from the WS message path); still crash-safe for the app.
  d.run("PRAGMA synchronous=NORMAL");
  d.run("CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
  d.run("CREATE TABLE IF NOT EXISTS events (event_key TEXT PRIMARY KEY, kalshi_ticker TEXT NOT NULL)");
  // Price-to-beat per 15m window (windowStart = unix seconds), so a restart mid-window keeps the strike.
  d.run("CREATE TABLE IF NOT EXISTS strikes (windowStart INTEGER NOT NULL, venue TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (windowStart, venue))");
  d.run("CREATE TABLE IF NOT EXISTS episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, combo TEXT, event_key TEXT, start_recv REAL, duration_ms REAL, killed_by TEXT, censored INTEGER, data TEXT NOT NULL)");
  d.run("CREATE TABLE IF NOT EXISTS exec_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, strategy TEXT, outcome TEXT, ts REAL, data TEXT NOT NULL)");
  d.run("CREATE TABLE IF NOT EXISTS latency_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, data TEXT NOT NULL)");
  return (_db = d);
}

const row = (r: any): Trade => ({ ...JSON.parse(r.data), id: r.id });

export function insertTrade(t: Omit<Trade, "id">): Trade {
  const r = db().query("INSERT INTO trades (event_key,status,data) VALUES (?,?,?) RETURNING id").get(t.eventKey, t.status, JSON.stringify(t)) as { id: number };
  return { ...t, id: r.id };
}
export function updateTrade(t: Trade) {
  db().query("UPDATE trades SET status=?, data=? WHERE id=?").run(t.status, JSON.stringify(t), t.id);
}
export const allTrades = (): Trade[] => (db().query("SELECT id,data FROM trades ORDER BY id").all() as any[]).map(row);
export function saveEvent(eventKey: string, ticker: string) {
  db().query("INSERT OR REPLACE INTO events VALUES (?,?)").run(eventKey, ticker);
}
export const loadEvents = (): Record<string, string> =>
  Object.fromEntries((db().query("SELECT * FROM events").all() as any[]).map((r) => [r.event_key, r.kalshi_ticker]));

export interface StoredStrike { value: number; source: string }
export function saveStrike(windowStart: number, venue: string, value: number, source: string) {
  db().query("INSERT OR REPLACE INTO strikes (windowStart,venue,value,source) VALUES (?,?,?,?)").run(windowStart, venue, value, source);
}
export function loadStrike(windowStart: number, venue: string): StoredStrike | null {
  const r = db().query("SELECT value,source FROM strikes WHERE windowStart=? AND venue=?").get(windowStart, venue) as StoredStrike | null;
  return r && Number(r.value) > 0 ? { value: Number(r.value), source: String(r.source) } : null;
}

// --- realistic execution simulation persistence (best effort; callers wrap in try/catch) ---
export function saveEpisodeRow(e: { combo: string; eventKey: string; startRecv: number; durationMs: number | null; killedBy: string | null; censored: boolean }) {
  db().query("INSERT INTO episodes (combo,event_key,start_recv,duration_ms,killed_by,censored,data) VALUES (?,?,?,?,?,?,?)")
    .run(e.combo, e.eventKey, e.startRecv, e.durationMs, e.killedBy, e.censored ? 1 : 0, JSON.stringify(e));
}
export function saveAttemptRow(tradeId: number | null, strategy: string, outcome: string, ts: number, data: unknown) {
  db().query("INSERT INTO exec_attempts (trade_id,strategy,outcome,ts,data) VALUES (?,?,?,?,?)").run(tradeId, strategy, outcome, ts, JSON.stringify(data));
}
export function saveLatencySample(ts: number, data: unknown) {
  db().query("INSERT INTO latency_samples (ts,data) VALUES (?,?)").run(ts, JSON.stringify(data));
}
