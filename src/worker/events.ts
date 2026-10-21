import type { DB } from "@/lib/db";
import { kvGet, kvSet } from "@/lib/db";
import type { StationAlert, StationDevice } from "@/lib/deye/types";

// Notable changes are written to the `events` table. The future Telegram bot
// reads rows where sent_at IS NULL, sends them, and stamps sent_at.

export type EventType =
  | "alert_opened"
  | "alert_closed"
  | "device_offline"
  | "device_online"
  | "soc_low"
  | "soc_high"
  | "grid_down"
  | "grid_up"
  | "grid_outage_missed";

export function pushEvent(db: DB, type: EventType, payload: Record<string, unknown>, ts = Date.now()): void {
  db.prepare("INSERT INTO events(ts, type, payload) VALUES (?, ?, ?)").run(ts, type, JSON.stringify(payload));
}

/** Upserts alerts and emits open/close events for changes since the last poll. */
export function syncAlerts(db: DB, stationId: number, alerts: StationAlert[], now = Date.now()): void {
  const getPrev = db.prepare("SELECT status FROM alerts WHERE alert_id = ?");
  const upsert = db.prepare(`
    INSERT INTO alerts(alert_id, station_id, status, level, start_time, end_time, json, updated_at)
    VALUES (@alertId, @stationId, @status, @level, @start, @end, @json, @now)
    ON CONFLICT(alert_id) DO UPDATE SET status = excluded.status, level = excluded.level,
      end_time = excluded.end_time, json = excluded.json, updated_at = excluded.updated_at`);
  const firstSync = (db.prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n === 0;

  db.transaction(() => {
    for (const a of alerts) {
      const prev = getPrev.get(a.alertId) as { status: number | null } | undefined;
      upsert.run({
        alertId: a.alertId,
        stationId,
        status: a.status ?? null,
        level: a.level ?? null,
        start: a.alertStartTime ?? null,
        end: a.alertEndTime ?? null,
        json: JSON.stringify(a),
        now,
      });
      const summary = { alertId: a.alertId, name: a.alertName, deviceSn: a.deviceSn, level: a.level, impact: a.impact };
      // On the very first sync only currently-open alerts are announced, not the whole backlog.
      if (!prev && a.status === 1) pushEvent(db, "alert_opened", summary, now);
      else if (!prev && !firstSync && a.status === 0) pushEvent(db, "alert_closed", summary, now);
      else if (prev && prev.status === 1 && a.status === 0) pushEvent(db, "alert_closed", summary, now);
    }
  })();
}

export function trackDeviceStatus(db: DB, devices: StationDevice[], now = Date.now()): void {
  const prev = kvGet<Record<string, number | null>>(db, "device_status") ?? {};
  const next: Record<string, number | null> = {};
  for (const d of devices) {
    const s = d.connectStatus ?? null;
    next[d.deviceSn] = s;
    if (!(d.deviceSn in prev)) continue;
    if (prev[d.deviceSn] !== 0 && s === 0) pushEvent(db, "device_offline", { deviceSn: d.deviceSn, deviceType: d.deviceType }, now);
    if (prev[d.deviceSn] === 0 && s !== null && s !== 0) pushEvent(db, "device_online", { deviceSn: d.deviceSn, deviceType: d.deviceType }, now);
  }
  kvSet(db, "device_status", next);
}

/** Emits once when SOC crosses below `low` or reaches `high` (with hysteresis so it does not flap). */
export function trackSoc(db: DB, soc: number | null | undefined, low: number, high: number, now = Date.now()): void {
  if (soc == null) return;
  const state = kvGet<"low" | "high" | "normal">(db, "soc_state") ?? "normal";
  let next = state;
  if (soc <= low && state !== "low") {
    pushEvent(db, "soc_low", { soc, threshold: low }, now);
    next = "low";
  } else if (soc >= high && state !== "high") {
    pushEvent(db, "soc_high", { soc, threshold: high }, now);
    next = "high";
  } else if (soc > low + 5 && soc < high - 5) {
    next = "normal";
  }
  if (next !== state) kvSet(db, "soc_state", next);
}
