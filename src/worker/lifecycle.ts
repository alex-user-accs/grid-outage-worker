import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type DB, kvGet, kvSet } from "@/lib/db";
import { pushEvent } from "./events";

// Keeps an always-on worker honest: one instance at a time, and a notice when
// monitoring resumes after a gap (Mac asleep, crash, power loss, reboot).

const HEARTBEAT_KEY = "worker_heartbeat";
/** Gaps shorter than this are normal restarts (deploys, code edits) and are not announced. */
export const RESUME_NOTICE_AFTER_MS = 10 * 60_000;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// After a reboot the old pid in worker.pid often belongs to an unrelated process,
// so a live pid only counts if its command line is this worker.
const isWorker = (pid: number) => {
  let cmd: string;
  try {
    cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  } catch (e) {
    return (e as { status?: number }).status === undefined; // ps unavailable: assume it is, to be safe
  }
  return cmd.includes(path.join("src", "worker", "index"));
};

/**
 * Takes data/worker.pid. Returns an error message if another live worker holds it
 * (e.g. the launchd service is running and someone starts `npm run dev`).
 */
export function acquireWorkerLock(dir: string, pid = process.pid, isWorkerPid = isWorker): string | null {
  const file = path.join(dir, "worker.pid");
  fs.mkdirSync(dir, { recursive: true });
  const other = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : NaN);
  if (other && other !== pid && alive(other) && isWorkerPid(other)) {
    return `another worker is already running (pid ${other}). If the background service is installed, stop it first: npm run service:stop`;
  }
  fs.writeFileSync(file, String(pid));
  const release = () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(pid)) fs.unlinkSync(file);
    } catch {}
  };
  process.once("exit", release);
  return null;
}

/** Call on start, before the first heartbeat: queues monitoring_resumed if the previous run ended long ago. */
export function noteStartup(db: DB, now = Date.now()): number | null {
  const last = kvGet<number>(db, HEARTBEAT_KEY);
  if (last && now - last >= RESUME_NOTICE_AFTER_MS) {
    pushEvent(db, "monitoring_resumed", { downSince: last, downMin: Math.round((now - last) / 60_000) }, now);
    return now - last;
  }
  return null;
}

export function heartbeat(db: DB, now = Date.now()): void {
  kvSet(db, HEARTBEAT_KEY, now);
}

export const lastHeartbeat = (db: DB) => kvGet<number>(db, HEARTBEAT_KEY) ?? null;
