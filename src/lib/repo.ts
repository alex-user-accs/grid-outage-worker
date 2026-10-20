import "server-only";
import { type DB, getDb, kvGet } from "./db";
import { addDays, addMonths, parseDeyeTime, ym, ymd } from "./dates";
import { RATE_HEADERS_KEY, countCallsSince, startOfLocalDay, startOfLocalMonth } from "./deye/client";
import type { DeviceLatestItem, Station, StationAlert, StationDataItem, StationDevice, StationLatest } from "./deye/types";
import { limitsEnv } from "./env";
import { JOBS, expectedCallsPerDay } from "@/worker/jobs";
import { PAUSE_KEY, type JobState, type PauseState, jobKey } from "@/worker/scheduler";

// Read-only helpers for server components. Pages never call the Deye API;
// they only read what the worker stored.

const db = (): DB => getDb();

function snapshot<T>(kind: string, ref: string): { ts: number; data: T } | null {
  const row = db().prepare("SELECT ts, json FROM snapshots WHERE kind = ? AND ref = ?").get(kind, ref) as { ts: number; json: string } | undefined;
  return row ? { ts: row.ts, data: JSON.parse(row.json) as T } : null;
}

function history(stationId: number, g: number, period: string): StationDataItem[] {
  const row = db().prepare("SELECT json FROM history WHERE station_id = ? AND granularity = ? AND period = ?").get(stationId, g, period) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as StationDataItem[]) : [];
}

export const stationId = () => kvGet<number>(db(), "station_id");

export function getStation(): Station | null {
  const id = stationId();
  return id ? (snapshot<Station>("station", String(id))?.data ?? null) : null;
}

export function getLatest(): { ts: number; data: StationLatest } | null {
  const id = stationId();
  return id ? snapshot<StationLatest>("station_latest", String(id)) : null;
}

// Sign conventions, confirmed against live data (inverter TotalGridPower / BatteryCurrent):
// grid + = import, − = export; battery + = discharge, − = charge.
// Deye fills `wirePower` (signed grid power) and leaves `gridPower`/`purchasePower` null on hybrid inverters.
type PowerFields = Pick<StationDataItem, "gridPower" | "wirePower" | "purchasePower" | "batteryPower" | "chargePower" | "dischargePower">;

export function signedGridPower(i: PowerFields): number | null {
  return i.gridPower ?? i.wirePower ?? i.purchasePower ?? null;
}

export function signedBatteryPower(i: PowerFields): number | null {
  if (i.batteryPower != null) return i.batteryPower;
  if (i.chargePower != null || i.dischargePower != null) return (i.dischargePower ?? 0) - (i.chargePower ?? 0);
  return null;
}

export interface PowerPoint {
  t: number;
  pv: number | null;
  load: number | null;
  grid: number | null;
  battery: number | null;
  soc: number | null;
}

export function getTodayCurve(now = Date.now()): PowerPoint[] {
  const id = stationId();
  if (!id) return [];
  return history(id, 1, ymd(new Date(now)))
    .map((i) => ({
      t: parseDeyeTime(i.timeStamp) ?? 0,
      pv: i.generationPower ?? null,
      load: i.consumptionPower ?? null,
      grid: signedGridPower(i),
      battery: signedBatteryPower(i),
      soc: i.batterySOC ?? null,
    }))
    .filter((p) => p.t > 0)
    .sort((a, b) => a.t - b.t);
}

export interface EnergyPoint {
  label: string;
  generation: number | null;
  consumption: number | null;
  purchase: number | null;
  feedIn: number | null;
}

const toEnergy = (label: string, i: StationDataItem): EnergyPoint => ({
  label,
  generation: i.generationValue ?? null,
  consumption: i.consumptionValue ?? null,
  purchase: i.purchaseValue ?? null,
  feedIn: i.gridValue ?? null,
});

function itemDate(i: StationDataItem): Date | null {
  if (i.year && i.month) return new Date(i.year, i.month - 1, i.day ?? 1);
  const t = parseDeyeTime(i.timeStamp);
  return t ? new Date(t) : null;
}

export function getDaily(days = 30, now = Date.now()): EnergyPoint[] {
  const id = stationId();
  if (!id) return [];
  const d = new Date(now);
  const items = [...history(id, 2, ym(addMonths(d, -1))), ...history(id, 2, ym(d))];
  const from = addDays(d, -(days - 1)).getTime();
  return items
    .map((i) => ({ i, date: itemDate(i) }))
    .filter((x): x is { i: StationDataItem; date: Date } => !!x.date && x.date.getTime() >= from)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map(({ i, date }) => toEnergy(ymd(date), i));
}

export function getMonthly(months = 12, now = Date.now()): EnergyPoint[] {
  const id = stationId();
  if (!id) return [];
  const y = new Date(now).getFullYear();
  const items = [...history(id, 3, String(y - 1)), ...history(id, 3, String(y))];
  return items
    .map((i) => ({ i, date: itemDate(i) }))
    .filter((x): x is { i: StationDataItem; date: Date } => !!x.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(-months)
    .map(({ i, date }) => toEnergy(ym(date), i));
}

export function getLifetime(): { generation: number; consumption: number; purchase: number; feedIn: number; years: number } | null {
  const id = stationId();
  if (!id) return null;
  const years = history(id, 4, "all");
  if (!years.length) return null;
  const s = (k: keyof StationDataItem) => years.reduce((a, i) => a + (Number(i[k]) || 0), 0);
  return { generation: s("generationValue"), consumption: s("consumptionValue"), purchase: s("purchaseValue"), feedIn: s("gridValue"), years: years.length };
}

export function getAlerts(limit = 50): StationAlert[] {
  const rows = db()
    .prepare("SELECT json FROM alerts ORDER BY (status = 1) DESC, start_time DESC LIMIT ?")
    .all(limit) as { json: string }[];
  return rows.map((r) => JSON.parse(r.json) as StationAlert);
}

export function getDevices(): { ts: number; devices: (StationDevice & { latest: { ts: number; data: DeviceLatestItem } | null })[] } | null {
  const id = stationId();
  const snap = id ? snapshot<StationDevice[]>("devices", String(id)) : null;
  if (!snap) return null;
  return { ts: snap.ts, devices: snap.data.map((d) => ({ ...d, latest: snapshot<DeviceLatestItem>("device_latest", d.deviceSn) })) };
}

export function getUsage(now = Date.now()) {
  const l = limitsEnv();
  const d = db();
  const dayStart = startOfLocalDay(now);
  const perEndpoint = d
    .prepare(
      `SELECT endpoint, COUNT(*) AS today, SUM(http_status >= 400 OR http_status IS NULL OR code != '1000000') AS errors, MAX(ts) AS last
       FROM api_calls WHERE ts >= ? GROUP BY endpoint ORDER BY today DESC`,
    )
    .all(dayStart) as { endpoint: string; today: number; errors: number; last: number }[];
  const recent = d
    .prepare("SELECT ts, endpoint, http_status, code, duration_ms FROM api_calls ORDER BY id DESC LIMIT 15")
    .all() as { ts: number; endpoint: string; http_status: number | null; code: string | null; duration_ms: number }[];
  return {
    today: countCallsSince(d, dayStart),
    month: countCallsSince(d, startOfLocalMonth(now)),
    lastHour: countCallsSince(d, now - 3_600_000),
    dailyCap: l.API_DAILY_CAP,
    monthlyCap: l.API_MONTHLY_CAP,
    qpm: l.API_QPM,
    expectedPerDay: Math.round(expectedCallsPerDay()),
    perEndpoint,
    recent,
  };
}

export function getWorkerStatus() {
  const d = db();
  return {
    pause: kvGet<PauseState>(d, PAUSE_KEY) ?? null,
    jobs: JOBS.map((j) => ({ name: j.name, intervalMs: j.intervalMs, description: j.description, state: kvGet<JobState>(d, jobKey(j.name)) ?? null })),
    token: kvGet<{ expiresAt: number }>(d, "deye_token")?.expiresAt ?? null,
    rateHeaders: kvGet<{ ts: number; headers: Record<string, string> }>(d, RATE_HEADERS_KEY) ?? null,
  };
}

export function getRecentEvents(limit = 20) {
  return db().prepare("SELECT id, ts, type, payload, sent_at FROM events ORDER BY id DESC LIMIT ?").all(limit) as {
    id: number;
    ts: number;
    type: string;
    payload: string;
    sent_at: number | null;
  }[];
}

export function getTodayCallsByEndpoint(now = Date.now()): Record<string, number> {
  const rows = db()
    .prepare("SELECT endpoint, COUNT(*) AS n FROM api_calls WHERE ts >= ? GROUP BY endpoint")
    .all(startOfLocalDay(now)) as { endpoint: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.endpoint, r.n]));
}
