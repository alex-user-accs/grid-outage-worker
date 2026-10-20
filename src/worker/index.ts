import fs from "node:fs";
import { getDb } from "@/lib/db";
import { createDeyeApi } from "@/lib/deye";
import { isMock, limitsEnv } from "@/lib/env";
import { JOBS, expectedCallsPerDay } from "./jobs";
import { Scheduler } from "./scheduler";

// Next.js loads .env itself; the standalone worker has to do it. Env is read lazily, so this runs in time.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const TICK_MS = 5_000;

const db = getDb();
const limits = limitsEnv();
const api = createDeyeApi(db);
const stationIdOverride = process.env.DEYE_STATION_ID ? Number(process.env.DEYE_STATION_ID) : undefined;
const scheduler = new Scheduler(db, api, JOBS, { socLow: limits.SOC_LOW, socHigh: limits.SOC_HIGH, stationIdOverride });

console.log(
  `[worker] started (${isMock() ? "MOCK mode, no real API calls" : "LIVE"}); ` +
    `expected ~${Math.round(expectedCallsPerDay())} calls/day, caps ${limits.API_DAILY_CAP}/day ${limits.API_MONTHLY_CAP}/month, ${limits.API_QPM} QPM`,
);

const timer = setInterval(() => void scheduler.tick(), TICK_MS);
void scheduler.tick();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
