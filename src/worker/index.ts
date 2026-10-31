import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db";
import { createDeyeApi } from "@/lib/deye";
import { isMock, limitsEnv, telegramEnv } from "@/lib/env";
import { TelegramApi } from "@/telegram/api";
import { CommandBot, Notifier, runCommandLoop } from "@/telegram/bot";
import type { Lang } from "@/telegram/i18n";
import { JOBS, expectedCallsPerDay } from "./jobs";
import { acquireWorkerLock, heartbeat, noteStartup } from "./lifecycle";
import { Scheduler } from "./scheduler";

// Next.js loads .env itself; the standalone worker has to do it. Env is read lazily, so this runs in time.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

// Ticks only read SQLite; a short tick keeps gridWatch close to its phase-locked time.
const TICK_MS = 2_000;

const lockError = acquireWorkerLock(path.dirname(path.resolve(process.env.DB_PATH || "data/deye.db")));
if (lockError) {
  console.error(`[worker] not starting: ${lockError}`);
  process.exit(1);
}

const db = getDb();
const resumedAfter = noteStartup(db);
if (resumedAfter) console.log(`[worker] resuming after a ${Math.round(resumedAfter / 60_000)} min gap`);
const limits = limitsEnv();
const api = createDeyeApi(db);
const stationIdOverride = process.env.DEYE_STATION_ID ? Number(process.env.DEYE_STATION_ID) : undefined;
const night = limits.NIGHT_HOURS;
const scheduler = new Scheduler(db, api, JOBS, { socLow: limits.SOC_LOW, socHigh: limits.SOC_HIGH, stationIdOverride, night });

console.log(
  `[worker] started (${isMock() ? "MOCK mode, no real API calls" : "LIVE"}); ` +
    `expected ~${Math.round(expectedCallsPerDay(JOBS, night))} calls/day (night ${night.startHour}:00–${night.endHour}:00 slower), ` +
    `caps ${limits.API_DAILY_CAP}/day ${limits.API_MONTHLY_CAP}/month, ${limits.API_QPM} QPM`,
);

// ---- Telegram (optional): reads the events table, adds no Deye API calls ----
const tgEnv = telegramEnv();
const stopBot = new AbortController();
let notifier: Notifier | null = null;
if (tgEnv) {
  const tg = new TelegramApi(tgEnv.TELEGRAM_BOT_TOKEN, { baseUrl: tgEnv.TELEGRAM_API_URL });
  const botOpts = {
    chatIds: tgEnv.TELEGRAM_CHAT_IDS,
    night,
    silentAtNight: tgEnv.TELEGRAM_SILENT_AT_NIGHT,
    defaultLang: tgEnv.TELEGRAM_LANGUAGE,
  };
  notifier = new Notifier(db, tg, botOpts);
  if (botOpts.chatIds.length) notifier.init();
  // Default menu plus one per language, so each user sees commands in their Telegram app's language.
  const menus: [Lang, string | undefined][] = [[botOpts.defaultLang, undefined], ["uk", "uk"], ["en", "en"]];
  for (const [lang, code] of menus) {
    void tg.setMyCommands(CommandBot.commands(lang), code).catch((e) => console.log(`[telegram] setMyCommands failed: ${(e as Error).message}`));
  }
  void runCommandLoop(new CommandBot(db, tg, botOpts), stopBot.signal, console.log);
  console.log(
    botOpts.chatIds.length
      ? `[telegram] notifications on for ${botOpts.chatIds.length} chat(s)${botOpts.silentAtNight ? ", silent at night" : ""}`
      : "[telegram] SETUP MODE: send /start to your bot to get your chat id, then set TELEGRAM_CHAT_IDS",
  );
} else {
  console.log("[telegram] off (TELEGRAM_BOT_TOKEN not set)");
}

// Drain right after each tick, so an event detected in this tick is sent within the same 2 s.
const cycle = async () => {
  heartbeat(db);
  await scheduler.tick();
  await notifier?.drain().catch((e) => console.log(`[telegram] ${(e as Error).message}`));
};
const timer = setInterval(() => void cycle(), TICK_MS);
void cycle();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    stopBot.abort();
    db.close();
    process.exit(0);
  });
}
