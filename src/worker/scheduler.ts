import type { DB } from "@/lib/db";
import { kvDelete, kvGet, kvSet } from "@/lib/db";
import { BudgetExceededError, startOfLocalDay, startOfLocalMonth } from "@/lib/deye/client";
import type { DeyeApi } from "@/lib/deye/types";
import { type Job, type JobContext, type NightWindow, isNight } from "./jobs";

export interface JobState {
  lastRun: number;
  /** Absent in states written by older versions: then lastRun + interval applies. */
  nextRun?: number;
  ok: boolean;
  error?: string;
  /** Consecutive failures, drives the retry backoff. */
  failures?: number;
  /** Whether nextRun was planned with the night interval. */
  night?: boolean;
  durationMs: number;
}

export interface PauseState {
  reason: string;
  until: number;
}

export const PAUSE_KEY = "worker_paused";
const RETRY_BASE_MS = 2 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;

/** After a failure: retry in 2, 4, 8 … min (max 1 h), but never later than the job's normal interval. */
export function retryDelay(failures: number, intervalMs: number): number {
  return Math.min(intervalMs, RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export const jobKey = (name: string) => `job:${name}`;

/**
 * Runs due jobs in order. Last-run times live in SQLite, so restarting the
 * worker (e.g. `tsx watch` on every save) does not re-fire every job.
 * A failed job retries with exponential backoff (2 min … 1 h); a skipped job
 * (missing prerequisite) is not recorded and is tried again next tick.
 */
export class Scheduler {
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly api: DeyeApi,
    private readonly jobs: Job[],
    private readonly opts: Pick<JobContext, "socLow" | "socHigh" | "stationIdOverride"> & {
      /** Quiet hours with slower polling; null disables. */
      night?: NightWindow | null;
      log?: (m: string) => void;
    },
  ) {}

  private log(m: string) {
    (this.opts.log ?? console.log)(`[worker] ${m}`);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pause = kvGet<PauseState>(this.db, PAUSE_KEY);
      if (pause) {
        if (now < pause.until) return;
        kvDelete(this.db, PAUSE_KEY);
        this.log("budget window reset; resuming");
      }
      const night = isNight(now, this.opts.night ?? null);
      for (const job of this.jobs) {
        const interval = night && job.nightIntervalMs ? job.nightIntervalMs : job.intervalMs;
        const state = kvGet<JobState>(this.db, jobKey(job.name));
        const planned = state ? (state.nextRun ?? state.lastRun + interval) : now;
        // Leaving the night window: don't keep waiting on the long night interval.
        const due = state && !!state.night !== night ? Math.min(planned, state.lastRun + interval) : planned;
        if (now < due) continue;
        const started = Date.now();
        try {
          const result = await job.run({ db: this.db, api: this.api, now, ...this.opts });
          if (result === "skipped") continue;
          // A job may pick its own next run (gridWatch phase-locks to logger uploads), but not at night.
          const nextRun = typeof result === "object" && !(night && job.nightIntervalMs) ? result.nextRun : now + interval;
          kvSet(this.db, jobKey(job.name), { lastRun: now, nextRun, ok: true, failures: 0, night, durationMs: Date.now() - started } satisfies JobState);
        } catch (err) {
          const message = (err as Error).message;
          const failures = (state?.ok === false ? (state.failures ?? 1) : 0) + 1;
          const nextRun = now + retryDelay(failures, interval);
          kvSet(this.db, jobKey(job.name), { lastRun: now, nextRun, ok: false, error: message, failures, night, durationMs: Date.now() - started } satisfies JobState);
          if (err instanceof BudgetExceededError) {
            const until = err.scope === "monthly" ? nextMonth(now) : nextDay(now);
            kvSet(this.db, PAUSE_KEY, { reason: message, until } satisfies PauseState);
            this.log(`PAUSED until ${new Date(until).toLocaleString()}: ${message}`);
            return;
          }
          this.log(`job ${job.name} failed (retry in ${Math.round((nextRun - now) / 60_000)} min): ${message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

const nextDay = (now: number) => startOfLocalDay(now) + 86_400_000 + 3_600_000; // +1h guards DST edges
const nextMonth = (now: number) => {
  const d = new Date(startOfLocalMonth(now));
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
};
