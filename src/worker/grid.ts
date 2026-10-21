import type { DB } from "@/lib/db";
import { kvGet, kvSet } from "@/lib/db";
import { pushEvent } from "./events";

// Grid outage detection. Deye's API has no grid-disconnection alerts (those only
// exist in the app's Message Center), so we derive them from the inverter's own
// readings: with the grid gone, GridVoltage drops to ~2.7 V and GridFrequency to 0 Hz.

/** Logger upload cadence, measured on the live system: one sample every 120 s. */
export const SAMPLE_MS = 120_000;
/** A sample becomes visible in /device/latest 38–47 s after its timestamp (measured); poll just after. */
export const VISIBLE_LAG_MS = 50_000;
/** If the expected sample is not there yet, look again this much later. */
export const RETRY_MS = 20_000;
/** Give up waiting for a late sample after this; fall back to plain SAMPLE_MS polling (logger offline?). */
const MAX_LATE_MS = 90_000;
/** Outages that overlap within this tolerance are the same outage. */
const MERGE_TOLERANCE_MS = 3 * 60_000;

export interface GridReading {
  online: boolean | null;
  voltage: number | null;
  frequency: number | null;
}

interface Point {
  key: string;
  value?: string | number | null;
}

const num = (v: Point["value"]) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Key names differ per model (e.g. GridVoltageL1L2 on single-phase, GridVoltageL1 on three-phase). */
export function gridKeys(points: Point[]): string[] {
  const v = points.find((p) => /^GridVoltage/i.test(p.key))?.key;
  const f = points.find((p) => /^GridFrequency$/i.test(p.key))?.key;
  return [v, f].filter((k): k is string => !!k);
}

export function readGrid(points: Point[]): GridReading {
  const voltage = num(points.find((p) => /^GridVoltage/i.test(p.key))?.value);
  const frequency = num(points.find((p) => /^GridFrequency$/i.test(p.key))?.value);
  if (voltage === null && frequency === null) return { online: null, voltage, frequency };
  // Normal grid here is 180–245 V / ~50 Hz; an outage reads ~2.7 V / 0 Hz. Low-voltage evenings (~190 V) stay "online".
  const down = (frequency !== null && frequency < 40) || (voltage !== null && voltage < 100);
  return { online: !down, voltage, frequency };
}

interface GridState {
  online: boolean;
  /** Timestamp of the first sample in the current state. */
  since: number;
  lastSampleAt: number;
}
export const GRID_STATE_KEY = "grid_state";

/** Applies one live sample: opens/closes outages and queues grid_down / grid_up events. */
export function trackGrid(db: DB, sampleAt: number, online: boolean, now = Date.now()): void {
  const state = kvGet<GridState>(db, GRID_STATE_KEY);
  if (state && sampleAt <= state.lastSampleAt) return;

  if (!state || state.online !== online) {
    if (!online) {
      const open = db.prepare("SELECT id FROM grid_outages WHERE end IS NULL").get();
      if (!open) db.prepare("INSERT INTO grid_outages(start, end, detected_at, source) VALUES (?, NULL, ?, 'live')").run(sampleAt, now);
      pushEvent(db, "grid_down", { start: sampleAt, detectedAt: now, delaySec: Math.round((now - sampleAt) / 1000), monitoringStarted: !state }, now);
    } else if (state) {
      const open = db.prepare("SELECT id, start FROM grid_outages WHERE end IS NULL ORDER BY start DESC").get() as { id: number; start: number } | undefined;
      if (open) db.prepare("UPDATE grid_outages SET end = ? WHERE id = ?").run(sampleAt, open.id);
      const start = open?.start ?? state.since;
      pushEvent(db, "grid_up", { start, end: sampleAt, durationMin: Math.round((sampleAt - start) / 60_000) }, now);
    }
    kvSet(db, GRID_STATE_KEY, { online, since: sampleAt, lastSampleAt: sampleAt } satisfies GridState);
    return;
  }
  kvSet(db, GRID_STATE_KEY, { ...state, lastSampleAt: sampleAt } satisfies GridState);
}

/**
 * Fills gaps from the 2-minute history (night-time 5-min polling, worker restarts):
 * completed outages that live polling missed are added and announced as grid_outage_missed
 * (or stored silently when `announce` is false, e.g. the first backfill). Ongoing outages are left to live tracking.
 */
export function reconcileGrid(db: DB, samples: { t: number; online: boolean }[], now = Date.now(), announce = true): number {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const intervals: { start: number; end: number | null }[] = [];
  let start: number | null = null;
  for (const s of sorted) {
    if (!s.online && start === null) start = s.t;
    if (s.online && start !== null) {
      intervals.push({ start, end: s.t });
      start = null;
    }
  }
  if (start !== null) intervals.push({ start, end: null });

  const overlapping = db.prepare(
    "SELECT id, start FROM grid_outages WHERE start <= ? AND (end IS NULL OR end >= ?) ORDER BY start LIMIT 1",
  );
  let added = 0;
  for (const iv of intervals) {
    const hit = overlapping.get((iv.end ?? now) + MERGE_TOLERANCE_MS, iv.start - MERGE_TOLERANCE_MS) as { id: number; start: number } | undefined;
    if (hit) {
      // History can know an earlier first-down sample than live polling did (e.g. after a restart).
      if (iv.start < hit.start) db.prepare("UPDATE grid_outages SET start = ? WHERE id = ?").run(iv.start, hit.id);
      continue;
    }
    if (iv.end === null) continue;
    db.prepare("INSERT INTO grid_outages(start, end, detected_at, source) VALUES (?, ?, ?, 'history')").run(iv.start, iv.end, now);
    if (announce) pushEvent(db, "grid_outage_missed", { start: iv.start, end: iv.end, durationMin: Math.round((iv.end - iv.start) / 60_000) }, now);
    added++;
  }
  return added;
}

/**
 * Phase-locked polling: ask for the next sample right after it should be visible,
 * instead of polling blindly. One call per logger upload, minimal detection delay.
 */
export function nextLivePoll(prevSampleAt: number | undefined, sampleAt: number, now: number): number {
  if (!prevSampleAt || sampleAt > prevSampleAt) return Math.max(now + 15_000, sampleAt + SAMPLE_MS + VISIBLE_LAG_MS);
  const expectedVisible = sampleAt + SAMPLE_MS + VISIBLE_LAG_MS;
  if (now < expectedVisible + MAX_LATE_MS) return now + RETRY_MS;
  return now + SAMPLE_MS;
}
