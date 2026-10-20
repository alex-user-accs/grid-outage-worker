import type { DB } from "../db";
import { deyeEnv, isMock, limitsEnv } from "../env";
import { DeyeClient, type DeyeClientOptions } from "./client";
import { MockDeyeClient } from "./mock";
import type { DeyeApi } from "./types";

export * from "./client";
export * from "./types";
export { MockDeyeClient } from "./mock";

/** Real client configured from .env, or the mock client when DEYE_MOCK=1. */
export function createDeyeApi(db: DB, overrides: Partial<DeyeClientOptions> = {}): DeyeApi {
  if (isMock()) return new MockDeyeClient();
  const e = deyeEnv();
  const l = limitsEnv();
  return new DeyeClient({
    baseUrl: e.DEYE_BASE_URL,
    appId: e.DEYE_APP_ID,
    appSecret: e.DEYE_APP_SECRET,
    email: e.DEYE_EMAIL,
    passwordSha256: e.DEYE_PASSWORD_SHA256,
    db,
    qpm: l.API_QPM,
    dailyCap: l.API_DAILY_CAP,
    monthlyCap: l.API_MONTHLY_CAP,
    ...overrides,
  });
}
