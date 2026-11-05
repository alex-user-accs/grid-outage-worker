// The ONLY script that calls the real Deye API on demand. Hard limit: 6 calls.
//   ALLOW_LIVE=1 npm run smoke
// Saves sanitized responses to tests/fixtures/live/ (git-ignored) and prints rate-limit headers.
import fs from "node:fs";
import path from "node:path";
import { getDb, kvGet } from "../src/lib/db";
import { ymd } from "../src/lib/dates";
import { DeyeClient, RATE_HEADERS_KEY } from "../src/lib/deye/client";
import { deyeEnv, limitsEnv } from "../src/lib/env";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
if (process.env.ALLOW_LIVE !== "1") {
  console.error("Refusing to call the live API. Re-run with ALLOW_LIVE=1 (makes at most 6 calls).");
  process.exit(1);
}

const MAX_CALLS = 6;
const OUT = "tests/fixtures/live";
const e = deyeEnv();
const l = limitsEnv();
const db = getDb();
const client = new DeyeClient({
  baseUrl: e.DEYE_BASE_URL,
  appId: e.DEYE_APP_ID,
  appSecret: e.DEYE_APP_SECRET,
  email: e.DEYE_EMAIL,
  passwordSha256: e.DEYE_PASSWORD_SHA256,
  db,
  qpm: l.API_QPM,
  dailyCap: l.API_DAILY_CAP,
  monthlyCap: l.API_MONTHLY_CAP,
  sessionCap: MAX_CALLS,
  maxRetries: 0, // never retry in a smoke run
});

// Strip personal data before writing fixtures.
const SENSITIVE = /^(locationAddress|locationLat|locationLng|contactPhone|ownerName|accessToken|refreshToken)$/;
const sanitize = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sanitize) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "<redacted>" : sanitize(x)]))
    : v;

function save(name: string, data: unknown) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(sanitize(data), null, 2));
  console.log(`  saved ${OUT}/${name}.json`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`→ ${name} … `);
  const res = await fn();
  console.log("ok");
  save(name, res);
  return res;
}

try {
  const stations = await step("station-list", () => client.stationList()); // includes the token call
  const station = (e.DEYE_STATION_ID && stations.find((s) => s.id === e.DEYE_STATION_ID)) || stations[0];
  if (!station) throw new Error("No stations found for this account");
  console.log(`  station: ${station.id} "${station.name}"`);
  await step("station-latest", () => client.stationLatest(station.id));
  const devices = await step("station-device", () => client.stationDevices(station.id));
  const sns = devices.filter((d) => d.deviceType !== "COLLECTOR").map((d) => d.deviceSn).slice(0, 10);
  if (sns.length) await step("device-latest", () => client.deviceLatest(sns));
  const now = new Date();
  await step("station-history-days", () => client.stationHistory(station.id, 2, ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)));
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  const u = client.usage();
  console.log(`\nCalls this run: ${u.session}/${MAX_CALLS} · today: ${u.today} · this month: ${u.month}`);
  const rh = kvGet<{ headers: Record<string, string> }>(db, RATE_HEADERS_KEY);
  console.log("Rate-limit headers:", rh ? rh.headers : "(none sent by Deye)");
}
