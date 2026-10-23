import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import type { Trade } from "./types.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath, { create: true });
db.run("PRAGMA journal_mode=WAL");
db.run("CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)");
db.run("CREATE TABLE IF NOT EXISTS events (event_key TEXT PRIMARY KEY, kalshi_ticker TEXT NOT NULL)");

const row = (r: any): Trade => ({ ...JSON.parse(r.data), id: r.id });

export function insertTrade(t: Omit<Trade, "id">): Trade {
  const r = db.query("INSERT INTO trades (event_key,status,data) VALUES (?,?,?) RETURNING id").get(t.eventKey, t.status, JSON.stringify(t)) as { id: number };
  return { ...t, id: r.id };
}
export function updateTrade(t: Trade) {
  db.query("UPDATE trades SET status=?, data=? WHERE id=?").run(t.status, JSON.stringify(t), t.id);
}
export const allTrades = (): Trade[] => (db.query("SELECT id,data FROM trades ORDER BY id").all() as any[]).map(row);
export function saveEvent(eventKey: string, ticker: string) {
  db.query("INSERT OR REPLACE INTO events VALUES (?,?)").run(eventKey, ticker);
}
export const loadEvents = (): Record<string, string> =>
  Object.fromEntries((db.query("SELECT * FROM events").all() as any[]).map((r) => [r.event_key, r.kalshi_ticker]));
