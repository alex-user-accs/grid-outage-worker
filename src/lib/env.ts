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
  /** Quiet hours with slower polling, local time "start-end" in whole hours. Same start and end disables it. */
  NIGHT_HOURS: z
    .string()
    .regex(/^\d{1,2}-\d{1,2}$/, "NIGHT_HOURS must look like 1-6")
    .default("1-6")
    .transform((v) => {
      const [startHour, endHour] = v.split("-").map(Number);
      return { startHour: startHour % 24, endHour: endHour % 24 };
    }),
});

const authSchema = z.object({
  ADMIN_PASSWORD_HASH: z
    .string()
    .startsWith("$argon2", "ADMIN_PASSWORD_HASH must be an argon2 hash; escape every $ as \\$ in .env (npm run hash-password -- admin prints it that way)"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
});

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, "TELEGRAM_BOT_TOKEN must look like 123456:ABC… (from @BotFather)"),
  /** Comma-separated chat ids allowed to use the bot. Empty = setup mode (the bot only tells you your chat id). */
  TELEGRAM_CHAT_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^-?\d+$/, "TELEGRAM_CHAT_IDS must be numeric chat ids, comma-separated"))),
  /** Language for chats that have not chosen one with /lang. */
  TELEGRAM_LANGUAGE: z.enum(["uk", "en"]).default("uk"),
  /** Bot API base URL; only for a proxy or tests. */
  TELEGRAM_API_URL: z.string().url().default("https://api.telegram.org"),
  /** Send notifications without sound during NIGHT_HOURS. */
  TELEGRAM_SILENT_AT_NIGHT: z
    .string()
    .optional()
    .transform((v) => v !== "0" && v !== "false"),
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
export type TelegramEnv = z.infer<typeof telegramSchema>;
/** null when the bot is not configured (no token): the worker then runs without it. */
export const telegramEnv = (): TelegramEnv | null => (process.env.TELEGRAM_BOT_TOKEN ? parse(telegramSchema, "Telegram") : null);
export const isMock = (): boolean => flag.parse(process.env.DEYE_MOCK);
export const dbPath = (): string => process.env.DB_PATH || "data/deye.db";
