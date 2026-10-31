import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "@/lib/db";
import { formatEvent } from "@/telegram/format";
import { acquireWorkerLock, heartbeat, noteStartup } from "@/worker/lifecycle";

describe("worker lifecycle", () => {
  it("announces monitoring_resumed only after a gap of 10+ minutes", () => {
    const db = openDb(":memory:");
    const t = new Date(2026, 9, 21, 9, 0).getTime();
    expect(noteStartup(db, t)).toBeNull(); // first ever start
    heartbeat(db, t);
    expect(noteStartup(db, t + 2 * 60_000)).toBeNull(); // quick restart (deploy, code edit)
    expect(noteStartup(db, t + 95 * 60_000)).toBe(95 * 60_000);
    const e = db.prepare("SELECT id, ts, type, payload FROM events").get() as { id: number; ts: number; type: string; payload: string };
    expect(e.type).toBe("monitoring_resumed");
    expect(formatEvent(e, e.ts)).toContain("Monitoring resumed</b> after 1 h 35 min (stopped at 09:00)");
  });

  it("refuses a second live worker but takes over a stale pid file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
    fs.writeFileSync(path.join(dir, "worker.pid"), String(process.ppid)); // a live process that is not us
    expect(acquireWorkerLock(dir, process.pid, () => true)).toMatch(/already running \(pid \d+\)/);
    // After a reboot the pid is reused by an unrelated process: take over.
    expect(acquireWorkerLock(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "worker.pid"), "999999"); // dead pid
    expect(acquireWorkerLock(dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, "worker.pid"), "utf8")).toBe(String(process.pid));
  });
});
