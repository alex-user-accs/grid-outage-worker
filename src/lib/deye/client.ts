import type { z } from "zod";
import { type DB, kvDelete, kvGet, kvSet } from "../db";
import {
  type DeyeApi,
  type Granularity,
  deviceLatestResponse,
  stationAlertResponse,
  stationDeviceResponse,
  stationHistoryResponse,
  stationLatest,
  stationListResponse,
  tokenResponse,
} from "./types";

const OK_CODE = "1000000";
const DAY_MS = 86_400_000;
const TOKEN_KEY = "deye_token";
export const RATE_HEADERS_KEY = "deye_rate_headers";

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: "daily" | "monthly" | "session",
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(`Deye API ${scope} call cap reached (${used}/${cap}); request blocked locally`);
    this.name = "BudgetExceededError";
  }
}

export class DeyeApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DeyeApiError";
  }
  get retryable(): boolean {
    return this.httpStatus === null || this.httpStatus === 429 || this.httpStatus >= 500;
  }
  get isAuth(): boolean {
    return this.httpStatus === 401 || this.httpStatus === 403;
  }
}

export interface DeyeClientOptions {
  baseUrl: string;
  appId: string;
  appSecret: string;
  email: string;
  passwordSha256: string;
  db: DB;
  /** Requests per minute we allow ourselves (Deye's limit is 60). */
  qpm: number;
  dailyCap: number;
  monthlyCap: number;
  /** Hard cap for this client instance (used by the smoke script). */
  sessionCap?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

interface RequestOpts {
  auth?: boolean;
  query?: Record<string, string>;
}

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalMonth(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

export function countCallsSince(db: DB, since: number): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM api_calls WHERE ts >= ? AND endpoint NOT LIKE 'mock:%'").get(since) as { n: number };
  return row.n;
}

/**
 * The only path to the Deye OpenAPI. Every request goes through:
 * budget check -> evenly spaced rate limiter -> fetch -> call log -> retry/backoff.
 */
export class DeyeClient implements DeyeApi {
  private readonly o: Required<Omit<DeyeClientOptions, "sessionCap">> & { sessionCap?: number };
  private nextSlot = 0;
  private cooldownUntil = 0;
  private sessionCalls = 0;
  private loginInFlight: Promise<string> | null = null;

  constructor(opts: DeyeClientOptions) {
    this.o = {
      maxRetries: 3,
      fetchImpl: globalThis.fetch.bind(globalThis),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: (m) => console.log(`[deye] ${m}`),
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    };
  }

  // ---------- public API (read-only endpoints) ----------

  async stationList() {
    const res = await this.request("/v1.0/station/list", { page: 1, size: 200 }, stationListResponse);
    return res.stationList;
  }

  async stationLatest(stationId: number) {
    return this.request("/v1.0/station/latest", { stationId }, stationLatest);
  }

  async stationHistory(stationId: number, granularity: Granularity, startAt: string, endAt?: string) {
    const body: Record<string, unknown> = { stationId, granularity, startAt };
    if (endAt) body.endAt = endAt;
    const res = await this.request("/v1.0/station/history", body, stationHistoryResponse);
    return res.stationDataItems;
  }

  async stationDevices(stationId: number) {
    const res = await this.request("/v1.0/station/device", { stationIds: [stationId], page: 1, size: 200 }, stationDeviceResponse);
    return res.deviceListItems;
  }

  /** Batched by 10 serial numbers per call (Deye limit). */
  async deviceLatest(deviceSns: string[]) {
    const out = [];
    for (let i = 0; i < deviceSns.length; i += 10) {
      const res = await this.request("/v1.0/device/latest", { deviceList: deviceSns.slice(i, i + 10) }, deviceLatestResponse);
      out.push(...res.deviceDataList);
    }
    return out;
  }

  /** Range must be <= 180 days. Pages of 200, at most 5 pages per call. */
  async stationAlerts(stationId: number, startTs: number, endTs: number) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const res = await this.request(
        "/v1.0/station/alertList",
        { stationId, startTimestamp: Math.floor(startTs / 1000), endTimestamp: Math.floor(endTs / 1000), page, size: 200 },
        stationAlertResponse,
      );
      out.push(...res.stationAlertItems);
      if (res.stationAlertItems.length < 200 || out.length >= (res.total ?? 0)) break;
    }
    return out;
  }

  // ---------- budget ----------

  usage() {
    const now = this.o.now();
    return {
      today: countCallsSince(this.o.db, startOfLocalDay(now)),
      month: countCallsSince(this.o.db, startOfLocalMonth(now)),
      session: this.sessionCalls,
    };
  }

  /** Throws BudgetExceededError if another call would cross a cap. */
  assertBudget(): void {
    const { today, month } = this.usage();
    if (this.o.sessionCap !== undefined && this.sessionCalls >= this.o.sessionCap)
      throw new BudgetExceededError("session", this.sessionCalls, this.o.sessionCap);
    if (today >= this.o.dailyCap) throw new BudgetExceededError("daily", today, this.o.dailyCap);
    if (month >= this.o.monthlyCap) throw new BudgetExceededError("monthly", month, this.o.monthlyCap);
  }

  // ---------- auth ----------

  private async token(): Promise<string> {
    const stored = kvGet<StoredToken>(this.o.db, TOKEN_KEY);
    // Re-login a day before expiry; Deye has no refresh endpoint.
    if (stored && stored.expiresAt - DAY_MS > this.o.now()) return stored.accessToken;
    this.loginInFlight ??= this.login().finally(() => (this.loginInFlight = null));
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    this.o.log("requesting new access token");
    const res = await this.request(
      "/v1.0/account/token",
      { appSecret: this.o.appSecret, email: this.o.email, password: this.o.passwordSha256 },
      tokenResponse,
      { auth: false, query: { appId: this.o.appId } },
    );
    const accessToken = /^bearer /i.test(res.accessToken) ? res.accessToken : `Bearer ${res.accessToken}`;
    kvSet(this.o.db, TOKEN_KEY, { accessToken, expiresAt: this.o.now() + res.expiresIn * 1000 } satisfies StoredToken);
    return accessToken;
  }

  tokenInfo(): { expiresAt: number } | null {
    const t = kvGet<StoredToken>(this.o.db, TOKEN_KEY);
    return t ? { expiresAt: t.expiresAt } : null;
  }

  // ---------- transport ----------

  private async request<S extends z.ZodTypeAny>(
    endpoint: string,
    body: unknown,
    schema: S,
    opts: RequestOpts = {},
    reauthed = false,
  ): Promise<z.infer<S>> {
    const auth = opts.auth ?? true;
    let attempt = 0;
    for (;;) {
      try {
        const authHeader = auth ? await this.token() : undefined;
        return await this.send(endpoint, body, schema, opts.query, authHeader);
      } catch (err) {
        if (!(err instanceof DeyeApiError)) throw err;
        if (err.isAuth && auth && !reauthed) {
          this.o.log(`auth rejected on ${endpoint}; re-login once`);
          kvDelete(this.o.db, TOKEN_KEY);
          return this.request(endpoint, body, schema, opts, true);
        }
        if (!err.retryable || attempt >= this.o.maxRetries) throw err;
        const delay = backoffDelay(attempt);
        if (err.httpStatus === 429) this.cooldownUntil = this.o.now() + delay;
        this.o.log(`${endpoint} failed (${err.message}); retry ${attempt + 1}/${this.o.maxRetries} in ${Math.round(delay / 1000)}s`);
        await this.o.sleep(delay);
        attempt++;
      }
    }
  }

  private async send<S extends z.ZodTypeAny>(
    endpoint: string,
    body: unknown,
    schema: S,
    query: Record<string, string> | undefined,
    authHeader: string | undefined,
  ): Promise<z.infer<S>> {
    this.assertBudget();
    await this.acquireSlot();
    this.assertBudget(); // re-check: another caller may have used the slot budget while we waited

    const url = `${this.o.baseUrl}${endpoint}${query ? `?${new URLSearchParams(query)}` : ""}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) headers.Authorization = authHeader;

    const started = this.o.now();
    let httpStatus: number | null = null;
    let code: string | undefined;
    let requestId: string | undefined;
    this.sessionCalls++;
    try {
      let res: Response;
      try {
        res = await this.o.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body ?? {}) });
      } catch (e) {
        throw new DeyeApiError(`network error: ${(e as Error).message}`, null);
      }
      httpStatus = res.status;
      this.captureRateHeaders(res.headers);
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new DeyeApiError(`HTTP ${res.status}: non-JSON response`, res.status);
      }
      const base = json as { code?: unknown; msg?: unknown; success?: unknown; requestId?: unknown };
      code = base.code !== undefined ? String(base.code) : undefined;
      requestId = typeof base.requestId === "string" ? base.requestId : undefined;
      if (!res.ok) throw new DeyeApiError(`HTTP ${res.status}: ${base.msg ?? res.statusText}`, res.status, code);
      if (base.success === false || (code !== undefined && code !== OK_CODE)) {
        const msg = String(base.msg ?? "unknown error");
        // Deye may report an expired token inside a 200 response.
        const looksAuth = /token|unauthori[sz]ed|login/i.test(msg) && endpoint !== "/v1.0/account/token";
        throw new DeyeApiError(`Deye error ${code}: ${msg}`, looksAuth ? 401 : res.status, code);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new Error(`Unexpected response shape from ${endpoint}: ${parsed.error.message}`);
      return parsed.data;
    } finally {
      this.o.db
        .prepare("INSERT INTO api_calls(ts, endpoint, http_status, code, request_id, duration_ms) VALUES (?, ?, ?, ?, ?, ?)")
        .run(started, endpoint, httpStatus, code ?? null, requestId ?? null, this.o.now() - started);
    }
  }

  /** Spaces requests evenly: at most `qpm` per minute, never bursts. Also honours 429 cooldown. */
  private async acquireSlot(): Promise<void> {
    const interval = 60_000 / this.o.qpm;
    const now = this.o.now();
    const slot = Math.max(now, this.nextSlot, this.cooldownUntil);
    this.nextSlot = slot + interval;
    if (slot > now) await this.o.sleep(slot - now);
  }

  private captureRateHeaders(h: Headers): void {
    const found: Record<string, string> = {};
    h.forEach((v, k) => {
      if (/rate|limit|quota|remaining|retry-after/i.test(k)) found[k] = v;
    });
    if (Object.keys(found).length) kvSet(this.o.db, RATE_HEADERS_KEY, { ts: this.o.now(), headers: found });
  }
}

/** Exponential backoff with jitter: ~1s, 2s, 4s ... capped at 5 min. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const base = Math.min(1000 * 2 ** attempt, 300_000);
  return Math.round(base * (0.75 + random() * 0.5));
}
