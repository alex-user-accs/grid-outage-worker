import type { DB } from "@/lib/db";
import { kvDelete, kvGet, kvSet } from "@/lib/db";
import { BudgetExceededError, startOfLocalDay, startOfLocalMonth } from "@/lib/deye/client";
import type { DeyeApi } from "@/lib/deye/types";
import type { Job, JobContext } from "./jobs";

export interface JobState {
  lastRun: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface PauseState {
  reason: string;
  until: number;
}

export const PAUSE_KEY = "worker_paused";
export const jobKey = (name: string) => `job:${name}`;

/**
 * Runs due jobs in order. Last-run times live in SQLite, so restarting the
 * worker (e.g. `tsx watch` on every save) does not re-fire every job.
 * A failed job waits for its normal interval: no retry storms.
 */
export class Scheduler {
  private running = false;

  constructor(
    private readonly db: DB,
    private readonly api: DeyeApi,
    private readonly jobs: Job[],
    private readonly opts: Pick<JobContext, "socLow" | "socHigh" | "stationIdOverride"> & { log?: (m: string) => void },
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
      for (const job of this.jobs) {
        const state = kvGet<JobState>(this.db, jobKey(job.name));
        if (state && now < state.lastRun + job.intervalMs) continue;
        const started = Date.now();
        try {
          await job.run({ db: this.db, api: this.api, now, ...this.opts });
          kvSet(this.db, jobKey(job.name), { lastRun: now, ok: true, durationMs: Date.now() - started } satisfies JobState);
        } catch (err) {
          const message = (err as Error).message;
          kvSet(this.db, jobKey(job.name), { lastRun: now, ok: false, error: message, durationMs: Date.now() - started } satisfies JobState);
          if (err instanceof BudgetExceededError) {
            const until = err.scope === "monthly" ? nextMonth(now) : nextDay(now);
            kvSet(this.db, PAUSE_KEY, { reason: message, until } satisfies PauseState);
            this.log(`PAUSED until ${new Date(until).toLocaleString()}: ${message}`);
            return;
          }
          this.log(`job ${job.name} failed: ${message}`);
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
