import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dbPath } from "./env";

export type DB = Database.Database;

// The web server only reads; the worker writes. WAL lets both work concurrently.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every request sent to Deye (including failed ones): the source of truth for the call budget.
CREATE TABLE IF NOT EXISTS api_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  endpoint    TEXT NOT NULL,
  http_status INTEGER,
  code        TEXT,
  request_id  TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS api_calls_ts ON api_calls(ts);

-- Latest payload per kind/ref, e.g. ('station_latest', '<stationId>'), ('device_latest', '<sn>').
CREATE TABLE IF NOT EXISTS snapshots (
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  json       TEXT NOT NULL,
  PRIMARY KEY (kind, ref)
);

-- Station history by granularity and period. final=1 means the period is over and is never refetched.
CREATE TABLE IF NOT EXISTS history (
  station_id  INTEGER NOT NULL,
  granularity INTEGER NOT NULL,
  period      TEXT NOT NULL,
  json        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL,
  final       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (station_id, granularity, period)
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id   TEXT PRIMARY KEY,
  station_id INTEGER NOT NULL,
  status     INTEGER,
  level      INTEGER,
  start_time INTEGER,
  end_time   INTEGER,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Grid outages detected from the inverter's grid voltage/frequency (end NULL = ongoing).
CREATE TABLE IF NOT EXISTS grid_outages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start       INTEGER NOT NULL,
  end         INTEGER,
  detected_at INTEGER NOT NULL,
  source      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grid_outages_start ON grid_outages(start);

-- Notable changes for notifications (future Telegram bot consumes rows where sent_at IS NULL).
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  type    TEXT NOT NULL,
  payload TEXT NOT NULL,
  sent_at INTEGER
);
`;

export function openDb(file = dbPath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

// One connection per process; survives Next.js dev hot reloads.
const g = globalThis as unknown as { __deyeDb?: DB };
export function getDb(): DB {
  g.__deyeDb ??= openDb();
  return g.__deyeDb;
}

export function kvGet<T>(db: DB, key: string): T | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function kvSet(db: DB, key: string, value: unknown): void {
  db.prepare(
    "INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value), Date.now());
}

export function kvDelete(db: DB, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}
