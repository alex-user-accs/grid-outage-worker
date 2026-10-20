import type { DB } from "@/lib/db";
import { kvGet, kvSet } from "@/lib/db";
import { addDays, addMonths, parseDeyeTime, ym, ymd } from "@/lib/dates";
import type { DeyeApi, Granularity, Station, StationDataItem, StationDevice } from "@/lib/deye/types";
import { syncAlerts, trackDeviceStatus, trackSoc } from "./events";

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface JobContext {
  db: DB;
  api: DeyeApi;
  now: number;
  socLow: number;
  socHigh: number;
  stationIdOverride?: number;
}

export interface Job {
  name: string;
  intervalMs: number;
  /** Deye endpoints this job calls, for the budget table and the API docs page. */
  endpoints: string[];
  /** Typical calls per run in steady state (excludes one-off backfills). */
  callsPerRun: number;
  description: string;
  /** Returns "skipped" when a prerequisite (e.g. the station id) is missing; the scheduler then retries next tick. */
  run(ctx: JobContext): Promise<void | "skipped">;
}

export function saveSnapshot(db: DB, kind: string, ref: string, data: unknown, ts = Date.now()): void {
  db.prepare(
    "INSERT INTO snapshots(kind, ref, ts, json) VALUES (?, ?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET ts = excluded.ts, json = excluded.json",
  ).run(kind, ref, ts, JSON.stringify(data));
}

function saveHistory(db: DB, stationId: number, g: Granularity, period: string, items: StationDataItem[], final: boolean, now: number) {
  db.prepare(
    `INSERT INTO history(station_id, granularity, period, json, fetched_at, final) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(station_id, granularity, period) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at, final = excluded.final`,
  ).run(stationId, g, period, JSON.stringify(items), now, final ? 1 : 0);
}

function isFinal(db: DB, stationId: number, g: Granularity, period: string): boolean {
  const row = db.prepare("SELECT final FROM history WHERE station_id = ? AND granularity = ? AND period = ?").get(stationId, g, period) as
    | { final: number }
    | undefined;
  return row?.final === 1;
}

const stationId = (db: DB) => kvGet<number>(db, "station_id");

export const JOBS: Job[] = [
  {
    name: "station",
    intervalMs: 24 * HOUR,
    endpoints: ["/v1.0/station/list"],
    callsPerRun: 1,
    description: "Discover the station (id, name, capacity, timezone).",
    async run({ db, api, now, stationIdOverride }) {
      const list = await api.stationList();
      const st: Station | undefined = stationIdOverride ? list.find((s) => s.id === stationIdOverride) : list[0];
      if (!st) throw new Error(stationIdOverride ? `Station ${stationIdOverride} not found in account` : "No stations in this account");
      kvSet(db, "station_id", st.id);
      saveSnapshot(db, "station", String(st.id), st, now);
    },
  },
  {
    name: "devices",
    intervalMs: HOUR,
    endpoints: ["/v1.0/station/device"],
    callsPerRun: 1,
    description: "Device list of the station (SN, type, online status). Cached 1 h as Deye recommends.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const devices = await api.stationDevices(id);
      saveSnapshot(db, "devices", String(id), devices, now);
      trackDeviceStatus(db, devices, now);
    },
  },
  {
    name: "stationLatest",
    intervalMs: 2 * MIN,
    endpoints: ["/v1.0/station/latest"],
    callsPerRun: 1,
    description: "Live power flow: PV, load, grid, battery, SOC.",
    async run({ db, api, now, socLow, socHigh }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const latest = await api.stationLatest(id);
      saveSnapshot(db, "station_latest", String(id), latest, now);
      trackSoc(db, latest.batterySOC, socLow, socHigh, now);
    },
  },
  {
    name: "deviceLatest",
    intervalMs: 5 * MIN,
    endpoints: ["/v1.0/device/latest"],
    callsPerRun: 1,
    description: "Raw measure points of every non-logger device, batched 10 SNs per call.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const row = db.prepare("SELECT json FROM snapshots WHERE kind = 'devices' AND ref = ?").get(String(id)) as { json: string } | undefined;
      if (!row) return "skipped";
      const devices: StationDevice[] = JSON.parse(row.json);
      const sns = devices.filter((d) => d.deviceType !== "COLLECTOR").map((d) => d.deviceSn);
      if (!sns.length) return;
      for (const item of await api.deviceLatest(sns)) saveSnapshot(db, "device_latest", item.deviceSn, item, now);
    },
  },
  {
    name: "todayCurve",
    intervalMs: 10 * MIN,
    endpoints: ["/v1.0/station/history"],
    callsPerRun: 1,
    description: "Intraday power frames for today (granularity 1). Yesterday is fetched once more after midnight, then frozen.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const today = new Date(now);
      const yesterday = ymd(addDays(today, -1));
      if (!isFinal(db, id, 1, yesterday) && db.prepare("SELECT 1 FROM history WHERE station_id = ? AND granularity = 1 AND period = ?").get(id, yesterday)) {
        saveHistory(db, id, 1, yesterday, await api.stationHistory(id, 1, yesterday, yesterday), true, now);
      }
      // Deye rejects granularity 1 without endAt (code 2101006), although its docs only mention startAt.
      saveHistory(db, id, 1, ymd(today), await api.stationHistory(id, 1, ymd(today), ymd(today)), false, now);
    },
  },
  {
    name: "alerts",
    intervalMs: 10 * MIN,
    endpoints: ["/v1.0/station/alertList"],
    callsPerRun: 1,
    description: "Alerts of the last 7 days (30 days on first run), to catch new and closed alerts.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const hasAny = db.prepare("SELECT 1 FROM alerts LIMIT 1").get();
      const from = now - (hasAny ? 7 : 30) * 24 * HOUR;
      syncAlerts(db, id, await api.stationAlerts(id, from, now), now);
    },
  },
  {
    name: "energy",
    intervalMs: HOUR,
    endpoints: ["/v1.0/station/history"],
    callsPerRun: 2,
    description: "Daily energy for the current month (gran 2) and monthly energy for the current year (gran 3). Past month/year fetched once and frozen.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const d = new Date(now);
      // Previous month / year: fetch once, keep forever (they no longer change).
      const prevMonth = addMonths(d, -1);
      if (!isFinal(db, id, 2, ym(prevMonth))) {
        saveHistory(db, id, 2, ym(prevMonth), await api.stationHistory(id, 2, ymd(prevMonth), ymd(addMonths(d, 0))), true, now);
      }
      const prevYear = String(d.getFullYear() - 1);
      if (!isFinal(db, id, 3, prevYear)) {
        saveHistory(db, id, 3, prevYear, await api.stationHistory(id, 3, `${prevYear}-01`, `${prevYear}-12`), true, now);
      }
      // Current periods: endAt is exclusive for days, so use tomorrow to include today.
      saveHistory(db, id, 2, ym(d), await api.stationHistory(id, 2, ymd(addMonths(d, 0)), ymd(addDays(d, 1))), false, now);
      saveHistory(db, id, 3, String(d.getFullYear()), await api.stationHistory(id, 3, `${d.getFullYear()}-01`, `${d.getFullYear()}-12`), false, now);
    },
  },
  {
    name: "lifetime",
    intervalMs: 6 * HOUR,
    endpoints: ["/v1.0/station/history"],
    callsPerRun: 1,
    description: "Yearly totals since commissioning (gran 4); summed for lifetime production/consumption.",
    async run({ db, api, now }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const st = db.prepare("SELECT json FROM snapshots WHERE kind = 'station' AND ref = ?").get(String(id)) as { json: string } | undefined;
      const started = st ? parseDeyeTime((JSON.parse(st.json) as Station).startOperatingTime) : null;
      const year = new Date(now).getFullYear();
      const fromYear = started ? new Date(started).getFullYear() : year - 9;
      saveHistory(db, id, 4, "all", await api.stationHistory(id, 4, String(fromYear), String(year)), false, now);
    },
  },
];

/** Expected steady-state calls per day for a job list (used by docs, status page and tests). */
export function expectedCallsPerDay(jobs: Job[] = JOBS): number {
  return jobs.reduce((n, j) => n + (86_400_000 / j.intervalMs) * j.callsPerRun, 0);
}
