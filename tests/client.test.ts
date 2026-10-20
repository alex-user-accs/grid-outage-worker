import { describe, expect, it } from "vitest";
import { type DB, kvGet, openDb } from "@/lib/db";
import { BudgetExceededError, DeyeApiError, DeyeClient, type DeyeClientOptions, backoffDelay, countCallsSince } from "@/lib/deye/client";

// All tests use a fake fetch and a virtual clock: zero real API calls, no real waiting.

const OK = { code: "1000000", msg: "success", success: true, requestId: "r1" };
const TOKEN = { ...OK, accessToken: "Bearer abc", expiresIn: "5183999", tokenType: "bearer" };

type Handler = (url: URL, body: Record<string, unknown>, headers: Record<string, string>) => { status?: number; json: unknown; headers?: Record<string, string> };

function setup(handler: Handler, opts: Partial<DeyeClientOptions> = {}) {
  const db = openDb(":memory:");
  let clock = Date.UTC(2026, 9, 20, 10, 0, 0);
  const calls: { path: string; body: Record<string, unknown>; at: number; auth?: string }[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = JSON.parse(String(init.body ?? "{}"));
    const headers = init.headers as Record<string, string>;
    calls.push({ path: url.pathname, body, at: clock, auth: headers.Authorization });
    const r = handler(url, body, headers);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  const client = new DeyeClient({
    baseUrl: "https://eu1-developer.deyecloud.com",
    appId: "app",
    appSecret: "secret",
    email: "a@b.c",
    passwordSha256: "0".repeat(64),
    db,
    qpm: 30,
    dailyCap: 1000,
    monthlyCap: 10000,
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    log: () => {},
    ...opts,
  });
  return { db, client, calls, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}

const routes =
  (extra: Record<string, Handler> = {}): Handler =>
  (url, body, headers) => {
    const h = extra[url.pathname];
    if (h) return h(url, body, headers);
    if (url.pathname === "/v1.0/account/token") return { json: TOKEN };
    if (url.pathname === "/v1.0/station/latest") return { json: { ...OK, generationPower: 1234, batterySOC: 80 } };
    if (url.pathname === "/v1.0/station/list") return { json: { ...OK, stationList: [{ id: 7, name: "Home" }], total: 1 } };
    if (url.pathname === "/v1.0/device/latest")
      return { json: { ...OK, deviceDataList: (body.deviceList as string[]).map((sn) => ({ deviceSn: sn, dataList: [] })) } };
    return { status: 404, json: { msg: "no route" } };
  };

describe("DeyeClient auth", () => {
  it("logs in once, sends appId in the query and the SHA-256 password, and reuses the token", async () => {
    const { client, calls, db } = setup(routes());
    await client.stationLatest(7);
    await client.stationLatest(7);
    const tokenCalls = calls.filter((c) => c.path === "/v1.0/account/token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toEqual({ appSecret: "secret", email: "a@b.c", password: "0".repeat(64) });
    expect(calls.filter((c) => c.path === "/v1.0/station/latest").every((c) => c.auth === "Bearer abc")).toBe(true);
    expect(kvGet<{ expiresAt: number }>(db, "deye_token")?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("adds the Bearer prefix if Deye returns a bare token", async () => {
    const { client, calls } = setup(routes({ "/v1.0/account/token": () => ({ json: { ...TOKEN, accessToken: "xyz" } }) }));
    await client.stationLatest(7);
    expect(calls.at(-1)?.auth).toBe("Bearer xyz");
  });

  it("re-logs in when the stored token is within a day of expiry", async () => {
    const { client, calls, advance } = setup(routes());
    await client.stationLatest(7);
    advance(5_183_999_000 - 86_400_000 + 1000);
    await client.stationLatest(7);
    expect(calls.filter((c) => c.path === "/v1.0/account/token")).toHaveLength(2);
  });

  it("re-logs in once on HTTP 401 and does not loop", async () => {
    const { client, calls } = setup(routes({ "/v1.0/station/latest": () => ({ status: 401, json: { msg: "unauthorized" } }) }));
    await expect(client.stationLatest(7)).rejects.toBeInstanceOf(DeyeApiError);
    expect(calls.filter((c) => c.path === "/v1.0/account/token")).toHaveLength(2);
    expect(calls.filter((c) => c.path === "/v1.0/station/latest")).toHaveLength(2);
  });
});

describe("DeyeClient errors", () => {
  it("treats a non-1000000 code as an error even with HTTP 200", async () => {
    const { client } = setup(routes({ "/v1.0/station/latest": () => ({ json: { code: "2101006", msg: "station not found", success: false } }) }));
    await expect(client.stationLatest(7)).rejects.toThrow(/2101006/);
  });

  it("backs off on 429 and succeeds after retry", async () => {
    let n = 0;
    const logs: string[] = [];
    const { client, calls } = setup(
      routes({ "/v1.0/station/latest": () => (++n <= 2 ? { status: 429, json: { msg: "too many" } } : { json: { ...OK, generationPower: 1 } }) }),
      { log: (m) => logs.push(m) },
    );
    const res = await client.stationLatest(7);
    expect(res.generationPower).toBe(1);
    expect(logs.filter((l) => /retry \d\/3/.test(l))).toHaveLength(2);
    // Each retry waits at least the backoff (>= 750 ms) after the 429.
    const latest = calls.filter((c) => c.path === "/v1.0/station/latest").map((c) => c.at);
    expect(latest[1] - latest[0]).toBeGreaterThanOrEqual(750);
    expect(latest[2] - latest[1]).toBeGreaterThanOrEqual(1500);
  });

  it("gives up after maxRetries on persistent 5xx and logs every attempt", async () => {
    const { client, db } = setup(routes({ "/v1.0/station/latest": () => ({ status: 503, json: { msg: "down" } }) }), { maxRetries: 2 });
    await expect(client.stationLatest(7)).rejects.toThrow(/503/);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM api_calls WHERE endpoint = '/v1.0/station/latest'").get() as { n: number }).n;
    expect(n).toBe(3);
  });

  it("does not retry 4xx client errors", async () => {
    const { client, calls } = setup(routes({ "/v1.0/station/latest": () => ({ status: 400, json: { msg: "bad" } }) }));
    await expect(client.stationLatest(7)).rejects.toThrow(/400/);
    expect(calls.filter((c) => c.path === "/v1.0/station/latest")).toHaveLength(1);
  });

  it("rejects unexpected response shapes", async () => {
    const { client } = setup(routes({ "/v1.0/station/list": () => ({ json: { ...OK, stationList: [{ name: "no id" }] } }) }));
    await expect(client.stationList()).rejects.toThrow(/Unexpected response shape/);
  });

  it("captures rate-limit headers", async () => {
    const { client, db } = setup(routes({ "/v1.0/station/latest": () => ({ json: OK, headers: { "X-RateLimit-Remaining": "59", "Content-Type": "application/json" } }) }));
    await client.stationLatest(7);
    expect(kvGet<{ headers: Record<string, string> }>(db, "deye_rate_headers")?.headers).toEqual({ "x-ratelimit-remaining": "59" });
  });
});

describe("DeyeClient limits", () => {
  it("spaces requests evenly at the configured QPM", async () => {
    const { client, calls } = setup(routes(), { qpm: 30 });
    for (let i = 0; i < 5; i++) await client.stationLatest(7);
    const times = calls.map((c) => c.at);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(2000);
    // 6 calls (token + 5) must never exceed 30 in any 60s window
    expect(times.filter((t) => t - times[0] < 60_000).length).toBeLessThanOrEqual(30);
  });

  it("blocks locally once the daily cap is reached, without calling Deye", async () => {
    const { client, calls } = setup(routes(), { dailyCap: 3 });
    await client.stationLatest(7); // token + latest = 2
    await client.stationLatest(7); // 3
    await expect(client.stationLatest(7)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(3);
  });

  it("enforces a session cap (used by the smoke script)", async () => {
    const { client } = setup(routes(), { sessionCap: 2 });
    await client.stationLatest(7);
    const err = await client.stationLatest(7).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).scope).toBe("session");
  });

  it("counts calls persisted by earlier processes toward the cap", async () => {
    const { client, db } = setup(routes(), { dailyCap: 5 });
    const ins = db.prepare("INSERT INTO api_calls(ts, endpoint) VALUES (?, 'x')");
    for (let i = 0; i < 5; i++) ins.run(Date.UTC(2026, 9, 20, 9, 0, 0));
    await expect(client.stationLatest(7)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("batches device/latest by 10 serial numbers", async () => {
    const { client, calls } = setup(routes());
    const sns = Array.from({ length: 23 }, (_, i) => `SN${i}`);
    const res = await client.deviceLatest(sns);
    expect(res).toHaveLength(23);
    const batches = calls.filter((c) => c.path === "/v1.0/device/latest").map((c) => (c.body.deviceList as string[]).length);
    expect(batches).toEqual([10, 10, 3]);
  });
});

describe("helpers", () => {
  it("backoffDelay grows exponentially with jitter and caps at 5 min", () => {
    expect(backoffDelay(0, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(8000);
    expect(backoffDelay(20, () => 1)).toBe(375_000);
    expect(backoffDelay(0, () => 0)).toBe(750);
  });

  it("countCallsSince ignores mock calls", () => {
    const db: DB = openDb(":memory:");
    db.prepare("INSERT INTO api_calls(ts, endpoint) VALUES (10, '/v1.0/station/latest'), (10, 'mock:/x')").run();
    expect(countCallsSince(db, 0)).toBe(1);
  });
});

