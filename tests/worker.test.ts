import { describe, expect, it } from "vitest";
import { kvGet, kvSet, openDb } from "@/lib/db";
import { BudgetExceededError } from "@/lib/deye/client";
import { MockDeyeClient } from "@/lib/deye/mock";
import type { DeyeApi } from "@/lib/deye/types";
import { pushEvent, syncAlerts, trackDeviceStatus, trackSoc } from "@/worker/events";
import { JOBS, expectedCallsPerDay } from "@/worker/jobs";
import { PAUSE_KEY, Scheduler, jobKey, retryDelay } from "@/worker/scheduler";
import { signedBatteryPower, signedGridPower } from "@/lib/repo";

/** Wraps the mock client and counts every method call as one API call (deviceLatest per 10 SNs). */
function counting(now: () => number) {
  const inner = new MockDeyeClient(now);
  const counts: Record<string, number> = {};
  const api = new Proxy(inner, {
    get(target, prop: string) {
      const fn = (target as unknown as Record<string, unknown>)[prop];
      if (typeof fn !== "function") return fn;
      return (...args: unknown[]) => {
        const n = prop === "deviceLatest" ? Math.ceil((args[0] as string[]).length / 10) : 1;
        counts[prop] = (counts[prop] ?? 0) + n;
        return (fn as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as DeyeApi;
  return { api, counts, total: () => Object.values(counts).reduce((a, b) => a + b, 0) };
}

const opts = { socLow: 20, socHigh: 100, log: () => {} };

describe("worker schedule", () => {
  it("documents ~1,373 calls/day ≈ 41k/month (≈41% of the 100k quota)", () => {
    const perDay = expectedCallsPerDay();
    expect(Math.round(perDay)).toBe(1373);
    expect(perDay * 30).toBeLessThan(45_000);
  });

  it("a simulated day makes about as many calls as budgeted, never above the daily cap", async () => {
    const db = openDb(":memory:");
    let t = new Date(2026, 9, 20, 0, 0, 30).getTime();
    const c = counting(() => t);
    const s = new Scheduler(db, c.api, JOBS, opts);
    const end = t + 86_400_000;
    for (; t < end; t += 60_000) await s.tick(t); // all intervals are whole minutes
    // Steady state ≈ 1373 + one-off backfills (previous month / previous year) on the first run.
    expect(c.total()).toBeGreaterThan(1300);
    expect(c.total()).toBeLessThan(1450);
    expect(c.counts.stationLatest).toBe(720);
  });

  it("does not re-fire jobs after a restart (last runs persist in SQLite)", async () => {
    const db = openDb(":memory:");
    const t = Date.now();
    const c1 = counting(() => t);
    await new Scheduler(db, c1.api, JOBS, opts).tick(t);
    const c2 = counting(() => t + 10_000);
    await new Scheduler(db, c2.api, JOBS, opts).tick(t + 10_000);
    expect(c2.total()).toBe(0);
  });

  it("pauses until the next day when the budget is exhausted", async () => {
    const db = openDb(":memory:");
    const t = new Date(2026, 9, 20, 12, 0).getTime();
    const failing = {
      stationList: async () => {
        throw new BudgetExceededError("daily", 3000, 3000);
      },
    } as unknown as DeyeApi;
    await new Scheduler(db, failing, JOBS, opts).tick(t);
    const pause = kvGet<{ until: number }>(db, PAUSE_KEY);
    expect(pause?.until).toBeGreaterThan(new Date(2026, 9, 21, 0, 0).getTime());
    // While paused, nothing runs.
    const c = counting(() => t);
    await new Scheduler(db, c.api, JOBS, opts).tick(t + 3_600_000);
    expect(c.total()).toBe(0);
  });

  it("stores snapshots and history the dashboard reads", async () => {
    const db = openDb(":memory:");
    const t = new Date(2026, 9, 20, 13, 0).getTime();
    await new Scheduler(db, new MockDeyeClient(() => t), JOBS, opts).tick(t);
    expect(kvGet<number>(db, "station_id")).toBe(1001);
    const kinds = (db.prepare("SELECT DISTINCT kind FROM snapshots ORDER BY kind").all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(["device_latest", "devices", "station", "station_latest"]);
    const periods = (db.prepare("SELECT granularity, period, final FROM history ORDER BY granularity, period").all() as object[]);
    expect(periods).toEqual([
      { granularity: 1, period: "2026-10-20", final: 0 },
      { granularity: 2, period: "2026-09", final: 1 },
      { granularity: 2, period: "2026-10", final: 0 },
      { granularity: 3, period: "2025", final: 1 },
      { granularity: 3, period: "2026", final: 0 },
      { granularity: 4, period: "all", final: 0 },
    ]);
  });
});

describe("scheduler recovery", () => {
  it("does not record dependent jobs as run when station discovery fails, and retries soon", async () => {
    const db = openDb(":memory:");
    const t = new Date(2026, 9, 20, 22, 17).getTime();
    let fail = true;
    const inner = new MockDeyeClient(() => t);
    const api = new Proxy(inner, {
      get: (target, prop: string) =>
        prop === "stationList" && fail
          ? async () => {
              throw new Error("Deye error 2101025: Incorrect password");
            }
          : (target as unknown as Record<string, unknown>)[prop],
    }) as DeyeApi;
    const s = new Scheduler(db, api, JOBS, opts);
    await s.tick(t);
    expect(kvGet(db, jobKey("station"))).toMatchObject({ ok: false, failures: 1, nextRun: t + 2 * 60_000 });
    expect(kvGet(db, jobKey("stationLatest"))).toBeUndefined(); // skipped, not "ok"
    fail = false; // user fixes .env
    await s.tick(t + 60_000);
    expect(kvGet<number>(db, "station_id")).toBeUndefined(); // still backing off
    await s.tick(t + 2 * 60_000);
    expect(kvGet<number>(db, "station_id")).toBe(1001);
    expect(kvGet(db, jobKey("stationLatest"))).toMatchObject({ ok: true });
  });

  it("retry delay doubles from 2 min, capped at 1 h and the job interval", () => {
    const H = 3_600_000;
    expect([1, 2, 3, 4, 7].map((f) => retryDelay(f, 24 * H) / 60_000)).toEqual([2, 4, 8, 16, 60]);
    expect(retryDelay(5, 2 * 60_000)).toBe(2 * 60_000);
  });
});

describe("power sign conventions (from live data)", () => {
  it("reads signed grid power from wirePower when gridPower is null", () => {
    expect(signedGridPower({ gridPower: null, wirePower: 1380, purchasePower: null })).toBe(1380);
    expect(signedGridPower({ gridPower: -500, wirePower: 1 })).toBe(-500);
    expect(signedGridPower({})).toBeNull();
  });
  it("battery: + discharge, − charge", () => {
    expect(signedBatteryPower({ batteryPower: -30 })).toBe(-30);
    expect(signedBatteryPower({ chargePower: 400, dischargePower: 0 })).toBe(-400);
    expect(signedBatteryPower({})).toBeNull();
  });
});

describe("notification events", () => {
  const types = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT type FROM events ORDER BY id").all() as { type: string }[]).map((r) => r.type);

  it("announces open alerts on first sync, then open→closed transitions", () => {
    const db = openDb(":memory:");
    syncAlerts(db, 1, [{ alertId: "a", status: 1 }, { alertId: "b", status: 0 }]);
    expect(types(db)).toEqual(["alert_opened"]);
    syncAlerts(db, 1, [{ alertId: "a", status: 0 }, { alertId: "b", status: 0 }]);
    expect(types(db)).toEqual(["alert_opened", "alert_closed"]);
  });

  it("detects devices going offline and back online", () => {
    const db = openDb(":memory:");
    trackDeviceStatus(db, [{ deviceSn: "X", connectStatus: 1 }]);
    trackDeviceStatus(db, [{ deviceSn: "X", connectStatus: 0 }]);
    trackDeviceStatus(db, [{ deviceSn: "X", connectStatus: 1 }]);
    expect(types(db)).toEqual(["device_offline", "device_online"]);
  });

  it("emits SOC low once with hysteresis", () => {
    const db = openDb(":memory:");
    for (const soc of [30, 19, 15, 22, 19, 40, 18]) trackSoc(db, soc, 20, 100);
    expect(types(db)).toEqual(["soc_low", "soc_low"]);
  });

  it("queues events with sent_at NULL for the future bot", () => {
    const db = openDb(":memory:");
    pushEvent(db, "soc_low", { soc: 10 });
    kvSet(db, "x", 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE sent_at IS NULL").get()).toEqual({ n: 1 });
  });
});
