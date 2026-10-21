import "server-only";
import spec from "@docs/deye-openapi.json";
import { ANNOTATIONS, kindOf } from "@docs/annotations";
import { fmtDuration, fmtInt } from "./format";
import { limitsEnv } from "./env";
import { JOBS, callsPerDay } from "@/worker/jobs";

type Operation = { summary?: string; description?: string; tags?: string[]; [k: string]: unknown };
type Spec = { info: Record<string, unknown>; paths: Record<string, Record<string, Operation>>; [k: string]: unknown };

const BADGE = {
  read: "",
  account: "",
  "device-read": "📡 **DEVICE READ COMMAND**: sends a command to the inverter. Not used by this app.",
  write: "⚠️ **WRITE: changes inverter / account state.** Not used by this app (read-only dashboard).",
} as const;

export interface EndpointUsage {
  path: string;
  jobs: { name: string; every: string; perMonth: number }[];
  today: number;
}

export function usageByPath(callsToday: Record<string, number>): Map<string, EndpointUsage> {
  const map = new Map<string, EndpointUsage>();
  for (const job of JOBS) {
    for (const path of job.endpoints) {
      const u = map.get(path) ?? { path, jobs: [], today: callsToday[path] ?? 0 };
      const every = job.nightIntervalMs ? `${fmtDuration(job.intervalMs)} (night ${fmtDuration(job.nightIntervalMs)})` : fmtDuration(job.intervalMs);
      u.jobs.push({ name: job.name, every, perMonth: Math.round(callsPerDay(job, limitsEnv().NIGHT_HOURS) * 30) });
      map.set(path, u);
    }
  }
  const token = "/v1.0/account/token";
  if (!map.has(token)) map.set(token, { path: token, jobs: [{ name: "auth", every: "~60 d", perMonth: 1 }], today: callsToday[token] ?? 0 });
  return map;
}

/** Deye's spec with our notes merged into every operation's description. Built per request so "today" counts are live. */
export function buildAnnotatedSpec(callsToday: Record<string, number>): Spec {
  const s = structuredClone(spec) as unknown as Spec;
  const usage = usageByPath(callsToday);

  s.info = {
    ...s.info,
    title: "Deye Cloud OpenAPI (annotated)",
    description:
      "Deye's official spec (EU1, `/v2/api-docs`) with this project's notes: limits in plain words, cache policy, " +
      "whether and how often our worker calls each endpoint, and today's live call count. *Try it out* is disabled on purpose.",
  };

  for (const [path, ops] of Object.entries(s.paths)) {
    for (const op of Object.values(ops)) {
      const a = ANNOTATIONS[path];
      const u = usage.get(path);
      const kind = kindOf(path);
      const parts: string[] = [];
      if (BADGE[kind]) parts.push(BADGE[kind]);
      if (u) {
        const total = u.jobs.reduce((n, j) => n + j.perMonth, 0);
        parts.push(
          `✅ **USED BY THIS APP**: ${u.jobs.map((j) => `\`${j.name}\` every ${j.every}`).join(", ")}; ≈ ${fmtInt(total)} calls/month. ` +
            `**Calls today: ${fmtInt(u.today)}**`,
        );
      } else if (kind === "read" || kind === "account") {
        parts.push("➖ Not used by this app.");
      }
      if (a?.limits?.length) parts.push(`**Limits & rules**\n\n${a.limits.map((l) => `- ${l}`).join("\n")}`);
      if (a?.cache) parts.push(`**Our cache policy:** ${a.cache}`);
      if (a?.notes?.length) parts.push(a.notes.map((n) => `- ${n}`).join("\n"));
      parts.push(`---\n\n**Deye’s description**\n\n${op.description || "_(none)_"}`);
      op.description = parts.join("\n\n");
      op["x-our-usage"] = { kind, used: !!u, ...(u ? { jobs: u.jobs } : {}) };
      if (kind === "write") op.summary = `⚠️ WRITE · ${op.summary ?? ""}`;
      else if (u) op.summary = `✅ ${op.summary ?? ""}`;
    }
  }
  return s;
}

export function specStats() {
  const ops = Object.entries((spec as unknown as Spec).paths).flatMap(([p, o]) => Object.keys(o).map(() => kindOf(p)));
  return { total: ops.length, write: ops.filter((k) => k === "write").length, deviceRead: ops.filter((k) => k === "device-read").length };
}
