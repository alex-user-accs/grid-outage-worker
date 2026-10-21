import { describe, expect, it } from "vitest";
import { kvGet, openDb } from "@/lib/db";
import { GRID_STATE_KEY, RETRY_MS, SAMPLE_MS, VISIBLE_LAG_MS, gridKeys, nextLivePoll, readGrid, reconcileGrid, trackGrid } from "@/worker/grid";

const p = (v: string, f: string) => [
  { key: "GridVoltageL1L2", value: v },
  { key: "GridFrequency", value: f },
];
const MIN = 60_000;
const t0 = new Date(2026, 9, 19, 8, 0).getTime();
const events = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT type, payload FROM events ORDER BY id").all() as { type: string; payload: string }[]).map((e) => ({ type: e.type, ...JSON.parse(e.payload) }));
const outages = (db: ReturnType<typeof openDb>) => db.prepare("SELECT start, end, source FROM grid_outages ORDER BY start").all();

describe("readGrid (values from the live inverter)", () => {
  it("2.7 V / 0 Hz is an outage", () => expect(readGrid(p("2.70", "0.00")).online).toBe(false));
  it("normal and low-voltage evenings are online", () => {
    expect(readGrid(p("228.10", "50.01")).online).toBe(true);
    expect(readGrid(p("193.30", "49.98")).online).toBe(true);
  });
  it("unknown when the model has no grid points", () => expect(readGrid([{ key: "SOC", value: "90" }]).online).toBeNull());
  it("finds model-specific key names", () => {
    expect(gridKeys([{ key: "GridVoltageL1" }, { key: "GridFrequency" }, { key: "SOC" }])).toEqual(["GridVoltageL1", "GridFrequency"]);
  });
});

describe("trackGrid", () => {
  it("opens and closes an outage with grid_down / grid_up events", () => {
    const db = openDb(":memory:");
    trackGrid(db, t0, true, t0 + 45_000);
    trackGrid(db, t0 + 2 * MIN, false, t0 + 2 * MIN + 50_000);
    trackGrid(db, t0 + 4 * MIN, false, t0 + 4 * MIN + 50_000);
    trackGrid(db, t0 + 64 * MIN, true, t0 + 64 * MIN + 50_000);
    expect(events(db)).toEqual([
      { type: "grid_down", start: t0 + 2 * MIN, detectedAt: t0 + 2 * MIN + 50_000, delaySec: 50, monitoringStarted: false },
      { type: "grid_up", start: t0 + 2 * MIN, end: t0 + 64 * MIN, durationMin: 62 },
    ]);
    expect(outages(db)).toEqual([{ start: t0 + 2 * MIN, end: t0 + 64 * MIN, source: "live" }]);
  });

  it("ignores repeated or older samples", () => {
    const db = openDb(":memory:");
    trackGrid(db, t0, true);
    trackGrid(db, t0 + 2 * MIN, false);
    trackGrid(db, t0 + 2 * MIN, true); // same sample again
    trackGrid(db, t0, true); // older
    expect(events(db).map((e) => e.type)).toEqual(["grid_down"]);
    expect(kvGet<{ online: boolean }>(db, GRID_STATE_KEY)?.online).toBe(false);
  });

  it("reports an outage already in progress when monitoring starts", () => {
    const db = openDb(":memory:");
    trackGrid(db, t0, false);
    expect(events(db)).toMatchObject([{ type: "grid_down", monitoringStarted: true }]);
  });
});

describe("reconcileGrid", () => {
  const samples = (downFrom: number, downTo: number, until = 120) =>
    Array.from({ length: until / 2 }, (_, i) => ({ t: t0 + i * 2 * MIN, online: !(i * 2 >= downFrom && i * 2 < downTo) }));

  it("adds a completed outage that live polling missed and announces it", () => {
    const db = openDb(":memory:");
    expect(reconcileGrid(db, samples(20, 30), t0 + 2 * 3_600_000)).toBe(1);
    expect(outages(db)).toEqual([{ start: t0 + 20 * MIN, end: t0 + 30 * MIN, source: "history" }]);
    expect(events(db)).toMatchObject([{ type: "grid_outage_missed", durationMin: 10 }]);
  });

  it("does not duplicate an outage seen live, but corrects an earlier start", () => {
    const db = openDb(":memory:");
    trackGrid(db, t0, true);
    trackGrid(db, t0 + 24 * MIN, false); // live saw it 4 min late (e.g. worker restarting)
    trackGrid(db, t0 + 30 * MIN, true);
    reconcileGrid(db, samples(20, 30));
    expect(outages(db)).toEqual([{ start: t0 + 20 * MIN, end: t0 + 30 * MIN, source: "live" }]);
    expect(events(db).filter((e) => e.type === "grid_outage_missed")).toHaveLength(0);
  });

  it("leaves ongoing outages to live tracking and can backfill silently", () => {
    const db = openDb(":memory:");
    expect(reconcileGrid(db, samples(100, 200))).toBe(0);
    reconcileGrid(db, samples(20, 30), Date.now(), false);
    expect(outages(db)).toHaveLength(1);
    expect(events(db)).toHaveLength(0);
  });
});

describe("nextLivePoll (phase-locked to logger uploads)", () => {
  const sample = t0;
  it("after a new sample: poll right when the next one becomes visible", () => {
    expect(nextLivePoll(sample - SAMPLE_MS, sample, sample + 45_000)).toBe(sample + SAMPLE_MS + VISIBLE_LAG_MS);
  });
  it("sample not there yet: retry shortly", () => {
    const now = sample + SAMPLE_MS + VISIBLE_LAG_MS;
    expect(nextLivePoll(sample, sample, now)).toBe(now + RETRY_MS);
  });
  it("logger silent for long: fall back to plain 2-min polling, no retry storm", () => {
    const now = sample + 10 * MIN;
    expect(nextLivePoll(sample, sample, now)).toBe(now + SAMPLE_MS);
  });
});
