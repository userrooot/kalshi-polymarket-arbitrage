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
  d.run("CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
  d.run("CREATE TABLE IF NOT EXISTS events (event_key TEXT PRIMARY KEY, kalshi_ticker TEXT NOT NULL)");
  // Price-to-beat per 15m window (windowStart = unix seconds), so a restart mid-window keeps the strike.
  d.run("CREATE TABLE IF NOT EXISTS strikes (windowStart INTEGER NOT NULL, venue TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY (windowStart, venue))");
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
