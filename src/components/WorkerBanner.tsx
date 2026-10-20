import { fmtDateTime } from "@/lib/format";
import type { PauseState } from "@/worker/scheduler";

export function WorkerBanner({ pause, hasData }: { pause: PauseState | null; hasData: boolean }) {
  if (pause)
    return (
      <div className="banner crit" role="alert">
        <strong>API polling paused.</strong> {pause.reason}. Resumes {fmtDateTime(pause.until)}. Data below may be stale.
      </div>
    );
  if (!hasData)
    return (
      <div className="banner info">
        No data yet. Make sure the worker is running (<code>npm run dev</code> starts it), or use <code>DEYE_MOCK=1</code> for demo data.
      </div>
    );
  return null;
}
