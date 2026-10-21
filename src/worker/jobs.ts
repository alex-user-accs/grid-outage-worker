import type { DB } from "@/lib/db";
import { kvGet, kvSet } from "@/lib/db";
import { addDays, addMonths, parseDeyeTime, ym, ymd } from "@/lib/dates";
import type { DeviceLatestItem, DeyeApi, Granularity, Station, StationDataItem, StationDevice } from "@/lib/deye/types";
import { syncAlerts, trackDeviceStatus, trackSoc } from "./events";
import { SAMPLE_MS, gridKeys, nextLivePoll, readGrid, reconcileGrid, trackGrid } from "./grid";

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

export interface NightWindow {
  /** Local hour the quiet period starts (inclusive), e.g. 1 for 01:00. */
  startHour: number;
  /** Local hour it ends (exclusive), e.g. 6 for 06:00. Equal to startHour disables night mode. */
  endHour: number;
}

export const DEFAULT_NIGHT: NightWindow = { startHour: 1, endHour: 6 };

export function isNight(now: number, night: NightWindow | null): boolean {
  if (!night || night.startHour === night.endHour) return false;
  const h = new Date(now).getHours();
  return night.startHour < night.endHour ? h >= night.startHour && h < night.endHour : h >= night.startHour || h < night.endHour;
}

const nightHours = (night: NightWindow | null) =>
  !night || night.startHour === night.endHour ? 0 : (night.endHour - night.startHour + 24) % 24;

export type JobResult = void | "skipped" | { nextRun: number };

export interface Job {
  name: string;
  intervalMs: number;
  /** Slower interval used during the night window (01:00–06:00 by default). */
  nightIntervalMs?: number;
  /** Deye endpoints this job calls, for the budget table and the API docs page. */
  endpoints: string[];
  /** Typical calls per run in steady state (excludes one-off backfills). */
  callsPerRun: number;
  description: string;
  /**
   * Returns "skipped" when a prerequisite (e.g. the station id) is missing; the scheduler then retries next tick.
   * Returns { nextRun } to choose its own next run time (daytime only; at night nightIntervalMs wins).
   */
  run(ctx: JobContext): Promise<JobResult>;
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

function stationDevices(db: DB): StationDevice[] | null {
  const id = stationId(db);
  const row = id ? (db.prepare("SELECT json FROM snapshots WHERE kind = 'devices' AND ref = ?").get(String(id)) as { json: string } | undefined) : undefined;
  return row ? (JSON.parse(row.json) as StationDevice[]) : null;
}

/** The device whose grid readings we watch: the (first) inverter. */
const gridDevice = (devices: StationDevice[]) =>
  devices.find((d) => d.deviceType === "INVERTER") ?? devices.find((d) => d.deviceType !== "COLLECTOR");

const LIVE_SAMPLE_KEY = "live_sample_at";
const GRID_KEYS_KEY = "grid_measure_points";
const GRID_HISTORY_DAY_KEY = "grid_history_day";

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
    name: "gridWatch",
    intervalMs: SAMPLE_MS,
    nightIntervalMs: 5 * MIN,
    endpoints: ["/v1.0/device/latest"],
    callsPerRun: 1,
    description:
      "Grid watch + device readings: polls right after each 2-min logger upload (phase-locked) to detect grid loss within ~1–3 min. 5 min at night.",
    async run({ db, api, now }) {
      const devices = stationDevices(db);
      if (!devices) return "skipped";
      const sns = devices.filter((d) => d.deviceType !== "COLLECTOR").map((d) => d.deviceSn);
      if (!sns.length) return;
      const items = await api.deviceLatest(sns);
      for (const item of items) saveSnapshot(db, "device_latest", item.deviceSn, item, now);

      const watched = gridDevice(devices);
      const item: DeviceLatestItem | undefined = items.find((i) => i.deviceSn === watched?.deviceSn);
      const sampleAt = parseDeyeTime(item?.collectionTime);
      if (!item || !sampleAt) return;
      const grid = readGrid(item.dataList);
      if (grid.online !== null) trackGrid(db, sampleAt, grid.online, now);
      const keys = gridKeys(item.dataList);
      if (keys.length) kvSet(db, GRID_KEYS_KEY, keys);

      const prev = kvGet<number>(db, LIVE_SAMPLE_KEY);
      kvSet(db, LIVE_SAMPLE_KEY, Math.max(prev ?? 0, sampleAt));
      return { nextRun: nextLivePoll(prev, sampleAt, now) };
    },
  },
  {
    name: "gridHistory",
    intervalMs: HOUR,
    endpoints: ["/v1.0/device/history"],
    callsPerRun: 1,
    description: "Checks today's 2-min grid voltage history for outages live polling missed (night, restarts). Yesterday once after midnight.",
    async run({ db, api, now }) {
      const devices = stationDevices(db);
      const keys = kvGet<string[]>(db, GRID_KEYS_KEY);
      const watched = devices && gridDevice(devices);
      if (!watched || !keys?.length) return "skipped";
      const today = ymd(new Date(now));
      const lastDay = kvGet<string>(db, GRID_HISTORY_DAY_KEY);
      const days = lastDay !== today ? [ymd(addDays(new Date(now), -1)), today] : [today];
      for (const day of days) {
        const samples = (await api.deviceHistoryDay(watched.deviceSn, day, keys))
          .map((s) => ({ t: parseDeyeTime(s.time) ?? 0, online: readGrid(s.itemList).online }))
          .filter((s): s is { t: number; online: boolean } => s.t > 0 && s.online !== null);
        // The very first run backfills history: record old outages without notifying.
        reconcileGrid(db, samples, now, lastDay !== undefined);
      }
      kvSet(db, GRID_HISTORY_DAY_KEY, today);
    },
  },
  {
    name: "stationLatest",
    intervalMs: 5 * MIN,
    nightIntervalMs: 15 * MIN,
    endpoints: ["/v1.0/station/latest"],
    callsPerRun: 1,
    description: "Live power flow tiles: PV, load, grid, battery, SOC. Deye refreshes this summary at most every 5 min.",
    async run({ db, api, now, socLow, socHigh }) {
      const id = stationId(db);
      if (!id) return "skipped";
      const latest = await api.stationLatest(id);
      saveSnapshot(db, "station_latest", String(id), latest, now);
      trackSoc(db, latest.batterySOC, socLow, socHigh, now);
    },
  },
  {
    name: "todayCurve",
    intervalMs: 10 * MIN,
    nightIntervalMs: 30 * MIN,
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
    nightIntervalMs: 30 * MIN,
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

/** Expected steady-state calls per day for one job, honouring the night window (excludes late-sample retries). */
export function callsPerDay(job: Job, night: NightWindow | null = DEFAULT_NIGHT): number {
  const nightMs = (job.nightIntervalMs ? nightHours(night) : 0) * HOUR;
  const dayMs = 24 * HOUR - nightMs;
  return (dayMs / job.intervalMs + (job.nightIntervalMs ? nightMs / job.nightIntervalMs : 0)) * job.callsPerRun;
}

/** Expected steady-state calls per day for a job list (used by docs, status page and tests). */
export function expectedCallsPerDay(jobs: Job[] = JOBS, night: NightWindow | null = DEFAULT_NIGHT): number {
  return jobs.reduce((n, j) => n + callsPerDay(j, night), 0);
}
