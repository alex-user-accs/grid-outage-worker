import { z } from "zod";

// Env is read lazily per concern so that e.g. mock mode does not require Deye
// credentials, and the worker does not require dashboard login settings.

const flag = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const deyeSchema = z.object({
  DEYE_BASE_URL: z.string().url().default("https://eu1-developer.deyecloud.com"),
  DEYE_APP_ID: z.string().min(1, "DEYE_APP_ID is required"),
  DEYE_APP_SECRET: z.string().min(1, "DEYE_APP_SECRET is required"),
  DEYE_EMAIL: z.string().email("DEYE_EMAIL must be the email of your Deye account"),
  DEYE_PASSWORD_SHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "DEYE_PASSWORD_SHA256 must be a 64-char hex SHA-256 (npm run hash-password -- deye)"),
  DEYE_STATION_ID: z.coerce.number().int().positive().optional(),
});

const limitsSchema = z.object({
  API_QPM: z.coerce.number().int().min(1).max(60).default(30),
  API_DAILY_CAP: z.coerce.number().int().min(1).default(3000),
  API_MONTHLY_CAP: z.coerce.number().int().min(1).default(90000),
  SOC_LOW: z.coerce.number().min(0).max(100).default(20),
  SOC_HIGH: z.coerce.number().min(0).max(100).default(100),
});

const authSchema = z.object({
  ADMIN_PASSWORD_HASH: z
    .string()
    .startsWith("$argon2", "ADMIN_PASSWORD_HASH must be an argon2 hash; escape every $ as \\$ in .env (npm run hash-password -- admin prints it that way)"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
});

function parse<T extends z.ZodTypeAny>(schema: T, name: string): z.infer<T> {
  const res = schema.safeParse(process.env);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid ${name} configuration in .env:\n${issues}`);
  }
  return res.data;
}

export type DeyeEnv = z.infer<typeof deyeSchema>;
export type LimitsEnv = z.infer<typeof limitsSchema>;

export const deyeEnv = (): DeyeEnv => parse(deyeSchema, "Deye API");
export const limitsEnv = (): LimitsEnv => parse(limitsSchema, "API limits");
export const authEnv = () => parse(authSchema, "dashboard auth");
export const isMock = (): boolean => flag.parse(process.env.DEYE_MOCK);
export const dbPath = (): string => process.env.DB_PATH || "data/deye.db";
