// Our own notes layered on top of Deye's Swagger spec (docs/deye-openapi.json).
// Merged into each operation's description on the /api-docs page.
// Polling intervals are not duplicated here: they come from the worker's JOBS.

export type Kind = "read" | "write" | "device-read" | "account";

export interface Annotation {
  /** Plain-language limits and rules Deye states (or that we observed). */
  limits?: string[];
  /** How long we treat the data as fresh. */
  cache?: string;
  notes?: string[];
}

/** Classifies every endpoint: anything that changes inverter/account state is "write". */
export function kindOf(path: string): Kind {
  if (path === "/v1.0/order/{orderId}" || path === "/v1.0/strategy/dynamicControl/readResult") return "read";
  if (path === "/v1.0/strategy/dynamicControl/read") return "device-read";
  if (/^\/v1\.0\/(order|strategy)\//.test(path)) return "write";
  if (/^\/v1\.0\/device\/(addLogger|deleteLogger|register)$/.test(path) || path === "/v1.0/station/create") return "write";
  if (path.startsWith("/v1.0/config/")) return "device-read";
  if (path.startsWith("/v1.0/account/")) return "account";
  return "read";
}

export const ANNOTATIONS: Record<string, Annotation> = {
  "/v1.0/account/token": {
    limits: [
      "`appId` goes in the query string; `appSecret` + one of email / username / mobile(+countryCode) in the body.",
      "`password` must be the **SHA-256 hex** of the account password, never plaintext.",
      "Token lifetime: `expiresIn` ≈ 5,184,000 s (60 days). There is **no refresh endpoint**: log in again.",
      "Personal user: omit `companyId`. Business member: pass `companyId` (from `/v1.0/account/info`).",
    ],
    cache: "Token stored in SQLite and reused until 1 day before expiry; re-login once on HTTP 401.",
    notes: ["The response already contains the `Bearer ` prefix. Send it verbatim as the `Authorization` header."],
  },
  "/v1.0/account/info": { notes: ["Only needed for business accounts (to obtain `companyId`). Not used: personal account."] },
  "/v1.0/station/list": { limits: ["Paged: `size` max 200, default 20."], cache: "24 h (station metadata rarely changes)." },
  "/v1.0/station/listWithDevice": { notes: ["Not used: `/station/list` + `/station/device` cover it and cache separately."] },
  "/v1.0/station/detail": { notes: ["Not used: `/station/list` already returns what the dashboard shows."] },
  "/v1.0/station/latest": {
    limits: ["Plant-level summaries are cached by Deye and refreshed **at most every 5 min** server-side."],
    cache: "2 min. Polling faster just returns the same data.",
    notes: ["Power fields are in **W**. `purchasePower`/`wirePower` = grid import/export, `chargePower`/`dischargePower` = battery."],
  },
  "/v1.0/station/history": {
    limits: [
      "granularity **1**: `startAt` = `yyyy-MM-dd`; intraday frames for that day (power fields only).",
      "granularity **2**: `startAt`/`endAt` = `yyyy-MM-dd`, `endAt` **exclusive**, range **≤ 31 days**.",
      "granularity **3**: `yyyy-MM`, range **≤ 12 months**.",
      "granularity **4**: `yyyy`; yearly values. Summing all years = lifetime totals (Deye FAQ).",
    ],
    cache: "Today: 10 min (gran 1) / 1 h (gran 2–3). Finished days, months and years are stored once and never refetched.",
    notes: ["Energy fields (`*Value`) are in **kWh**."],
  },
  "/v1.0/station/history/power": { limits: ["`startTimestamp`–`endTimestamp` (seconds) **≤ 12 months**."], notes: ["Not used: `/station/history` gran 1 is enough."] },
  "/v1.0/station/device": { limits: ["Up to **10 stations** per call; paged, `size` max 200."], cache: "1 h (Deye: cache device lists ~1 h)." },
  "/v1.0/station/alertList": {
    limits: ["10-digit Unix timestamps (seconds); range **≤ 180 days**; paged, `size` max 200."],
    cache: "10 min. We query the last 7 days (30 on the first run) to catch alerts closing.",
    notes: ["`level`: 0 notice, 1 warning, 2 failure. `impact`: 0 none, 1 production, 2 safety, 3 both. `status`: 1 open, 0 closed."],
  },
  "/v1.0/device/latest": {
    limits: ["Up to **10 device SNs** per call; batch them instead of one call per device."],
    cache: "5 min (loggers upload every 1–5 min).",
    notes: ["`deviceState`: 1 online, 2 alert, 3 offline. Values come as strings with a `unit`."],
  },
  "/v1.0/device/measurePoints": { notes: ["Lists measure-point names for `/device/history` gran 1. Static per model: cache indefinitely."] },
  "/v1.0/device/history": { limits: ["Same granularity rules as `/station/history`; gran 1 requires `measurePoints`."] },
  "/v1.0/device/historyRaw": { limits: ["Timestamps in seconds; range **≤ 5 days**."] },
  "/v1.0/device/alertList": { limits: ["Range **≤ 30 days**."], notes: ["Not used: `/station/alertList` covers all devices in one call."] },
  "/v1.0/device/list": { notes: ["Business members only."] },
  "/v1.0/order/{orderId}": { notes: ["Polls the result of a control command; `status` 666 = success."] },
};

export const GENERAL_LIMITS = {
  qpm: 60,
  monthlyQuota: 100_000,
  pollIntervalMin: "1–2 min",
  source: "developer.deyecloud.com → Best Practices (figures marked preliminary by Deye)",
};
