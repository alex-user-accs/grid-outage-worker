import { beforeEach, describe, expect, it } from "vitest";
import { type DB, kvGet, kvSet, openDb } from "@/lib/db";
import { TelegramApi, TelegramError, type TgUpdate } from "@/telegram/api";
import { CommandBot, Notifier } from "@/telegram/bot";
import { esc, formatEvent, hm, statusText } from "@/telegram/format";
import type { Lang } from "@/telegram/i18n";
import { pushEvent } from "@/worker/events";
import { saveSnapshot } from "@/worker/jobs";

// The read model uses the process-wide DB; point it at a fresh in-memory one per test.
let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
  (globalThis as unknown as { __deyeDb?: DB }).__deyeDb = db;
});

const T = new Date(2026, 9, 21, 11, 18, 53).getTime();

function seedInverter(soc = 85, load = 1200) {
  db.prepare("INSERT INTO kv(key, value, updated_at) VALUES ('station_id', '1', 0)").run();
  saveSnapshot(db, "devices", "1", [{ deviceSn: "INV", deviceType: "INVERTER", connectStatus: 1 }]);
  saveSnapshot(db, "device_latest", "INV", {
    deviceSn: "INV",
    collectionTime: T / 1000,
    dataList: [
      { key: "SOC", value: String(soc) },
      { key: "TotalConsumptionPower", value: String(load) },
      { key: "BatteryRatedCapacity", value: "315" },
      { key: "BatteryVoltage", value: "51.2" },
      { key: "GridVoltageL1L2", value: "2.70" },
      { key: "GridFrequency", value: "0.00" },
      { key: "TotalGridPower", value: "null" },
    ],
  });
}

/** Fake Telegram: records messages; `failWith` makes the next sends throw. */
function fakeTg() {
  const sent: { chat: string; text: string; silent: boolean }[] = [];
  const failures: (TelegramError | null)[] = []; // null = this send succeeds
  let updates: TgUpdate[] = [];
  const tg = {
    async sendMessage(chat: string | number, text: string, o: { silent?: boolean } = {}) {
      const f = failures.shift();
      if (f) throw f;
      sent.push({ chat: String(chat), text, silent: !!o.silent });
      return { message_id: sent.length, chat: { id: Number(chat), type: "private" } };
    },
    async getUpdates() {
      const u = updates;
      updates = [];
      return u;
    },
  } as unknown as TelegramApi;
  return { tg, sent, failWith: (e: TelegramError | null) => failures.push(e), queueUpdates: (u: TgUpdate[]) => (updates = u) };
}

const opts = (chatIds: string[], now = T + 60_000, defaultLang: Lang = "en") => ({
  chatIds,
  night: { startHour: 1, endHour: 6 },
  silentAtNight: true,
  defaultLang,
  log: () => {},
  now: () => now,
});
/** Event-delivery tests start with their chats already welcomed, so only event messages are counted. */
const welcomed = (...chats: string[]) => kvSet(db, "telegram_welcomed_chats", chats);
const unsent = () => (db.prepare("SELECT COUNT(*) AS n FROM events WHERE sent_at IS NULL").get() as { n: number }).n;

describe("message formatting", () => {
  it("grid_down shows time, battery and a runtime estimate", () => {
    seedInverter(85, 1200);
    const text = formatEvent({ id: 1, ts: T + 50_000, type: "grid_down", payload: JSON.stringify({ start: T, delaySec: 50 }) }, T + 52_000)!;
    expect(text).toContain("Grid OFF</b> since 11:18");
    expect(text).toContain("Battery <b>85%</b> · ≈ 13.7 kWh · load 1.2 kW"); // 315 Ah × 51.2 V × 85 %
    expect(text).toContain("≈ 11 h 25 min to empty");
    expect(text).toContain("Noticed 50 s after");
  });

  it("grid_up shows the outage duration", () => {
    const text = formatEvent({ id: 1, ts: T, type: "grid_up", payload: JSON.stringify({ start: T, end: T + 3_600_000 }) }, T + 3_600_000)!;
    expect(text).toContain("Grid is back</b> at 12:18");
    expect(text).toContain("<b>1 h 0 min</b> (11:18–12:18)");
  });

  it("marks late messages, escapes HTML, ignores unknown types", () => {
    const late = formatEvent({ id: 1, ts: T, type: "alert_opened", payload: JSON.stringify({ name: "<F35>", level: 2, impact: 1 }) }, T + 3_600_000)!;
    expect(late).toContain("&lt;F35&gt;");
    expect(late).toContain("Failure · affects production");
    expect(late).toContain("sent late; event at 11:18");
    expect(formatEvent({ id: 1, ts: T, type: "something_else", payload: "{}" }, T)).toBeNull();
    expect(esc("a & b")).toBe("a &amp; b");
    expect(hm(61 * 60_000)).toBe("1 h 1 min");
  });
});

describe("Notifier", () => {
  it("delivers queued events to every allowed chat, once", async () => {
    welcomed("111", "222");
    seedInverter();
    pushEvent(db, "grid_down", { start: T, delaySec: 50 }, T + 50_000);
    const { tg, sent } = fakeTg();
    const n = new Notifier(db, tg, opts(["111", "222"]));
    expect(await n.drain()).toBe(2);
    expect(sent.map((s) => s.chat)).toEqual(["111", "222"]);
    expect(await n.drain()).toBe(0);
    expect(unsent()).toBe(0);
  });

  it("retries after a network error without re-sending to chats that already got it", async () => {
    welcomed("111", "222");
    pushEvent(db, "soc_low", { soc: 18, threshold: 20 }, T);
    const { tg, sent, failWith } = fakeTg();
    let now = T + 60_000;
    const n = new Notifier(db, tg, { ...opts(["111", "222"]), now: () => now });
    failWith(null); // 111 ok
    failWith(new TelegramError("sendMessage: network error", null)); // 222 fails
    await n.drain();
    expect(sent.map((s) => s.chat)).toEqual(["111"]);
    expect(unsent()).toBe(1);
    now += 10_000;
    await n.drain();
    expect(sent.map((s) => s.chat)).toEqual(["111", "222"]);
    expect(unsent()).toBe(0);
  });

  it("honours 429 retry_after and skips chats that blocked the bot", async () => {
    welcomed("111");
    pushEvent(db, "soc_low", { soc: 18, threshold: 20 }, T);
    const { tg, sent, failWith } = fakeTg();
    let now = T + 60_000;
    const n = new Notifier(db, tg, { ...opts(["111"]), now: () => now });
    failWith(new TelegramError("sendMessage: 429", 429, 30));
    await n.drain();
    now += 20_000;
    expect(await n.drain()).toBe(0); // still inside retry_after
    now += 15_000;
    failWith(new TelegramError("sendMessage: 403 Forbidden: bot was blocked by the user", 403));
    await n.drain();
    expect(sent).toHaveLength(0);
    expect(unsent()).toBe(0); // given up for that chat, not retried forever
  });

  it("sends silently at night", async () => {
    welcomed("111");
    pushEvent(db, "grid_down", { start: T, delaySec: 50 }, T);
    const { tg, sent } = fakeTg();
    await new Notifier(db, tg, opts(["111"], new Date(2026, 9, 21, 3, 0).getTime())).drain();
    expect(sent[0].silent).toBe(true);
  });

  it("setup mode sends nothing; first real start skips the old backlog", async () => {
    welcomed("111");
    pushEvent(db, "soc_low", { soc: 18, threshold: 20 }, T - 3_600_000); // old
    const { tg, sent } = fakeTg();
    expect(await new Notifier(db, tg, opts([])).drain()).toBe(0);
    pushEvent(db, "grid_down", { start: T, delaySec: 50 }, T + 30_000); // recent
    const n = new Notifier(db, tg, opts(["111"]));
    n.init();
    await n.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Grid OFF");
  });
});

describe("CommandBot", () => {
  const msg = (chat: number, text: string, update_id = 1): TgUpdate => ({ update_id, message: { message_id: 1, chat: { id: chat, type: "private" }, text } });

  it("tells strangers only their chat id, and only on /start", async () => {
    const { tg, sent, queueUpdates } = fakeTg();
    const bot = new CommandBot(db, tg, opts(["111"]));
    queueUpdates([msg(999, "/status", 5), msg(999, "/start", 6)]);
    await bot.pollOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("private bot");
    expect(sent[0].text).toContain("<code>999</code>");
    expect(kvGet<number>(db, "telegram_update_offset")).toBe(7);
  });

  it("answers allowed chats from the local database", async () => {
    seedInverter();
    const { tg, sent, queueUpdates } = fakeTg();
    queueUpdates([msg(111, "/status@my_bot")]);
    await new CommandBot(db, tg, opts(["111"])).pollOnce();
    expect(sent[0].chat).toBe("111");
    expect(sent[0].text).toContain("Grid");
    expect(sent[0].text).toContain("Battery <b>85%</b>");
    expect(sent[0].text).not.toContain("NaN");
    expect(sent[0].text.match(/load/g)).toHaveLength(2); // "load 1.2 kW" once + "at this load"
  });
});

describe("TelegramApi", () => {
  it("never puts the token in errors and parses retry_after", async () => {
    const token = "123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789";
    const api = new TelegramApi(token, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }), { status: 429 })) as unknown as typeof fetch,
    });
    const err = (await api.sendMessage(1, "x").catch((e) => e)) as TelegramError;
    expect(err.retryAfter).toBe(7);
    expect(err.message).not.toContain(token);

    const down = new TelegramApi(token, {
      fetchImpl: (async (url: string) => {
        throw new Error(`connect failed ${url}`);
      }) as unknown as typeof fetch,
    });
    expect(((await down.sendMessage(1, "x").catch((e) => e)) as Error).message).not.toContain(token);
  });
});

describe("Ukrainian", () => {
  const msg = (chat: number, text: string, language_code?: string): TgUpdate => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat, language_code }, text },
  });

  it("formats grid events with Ukrainian wording, units and decimal commas", () => {
    seedInverter(85, 1200);
    const live = { soc: 85, load: 1200, pv: 0, grid: 0, battery: 0, storedKwh: 13.7088, hoursLeft: 11.424, at: T };
    const down = formatEvent({ id: 1, ts: T, type: "grid_down", payload: JSON.stringify({ start: T, delaySec: 50 }) }, T + 52_000, live, "uk")!;
    expect(down).toContain("Світло зникло</b> о 11:18");
    expect(down).toContain("Батарея <b>85%</b> · ≈ 13,7 кВт·год · навантаження 1,2 кВт");
    expect(down).toContain("≈ 11 год 25 хв до розряду");
    expect(down).toContain("Помічено через 50 с");
    const up = formatEvent({ id: 2, ts: T, type: "grid_up", payload: JSON.stringify({ start: T, end: T + 3_600_000 }) }, T + 3_600_000, live, "uk")!;
    expect(up).toContain("Світло повернулося</b> о 12:18");
    expect(up).toContain("Без світла: <b>1 год 0 хв</b> (11:18–12:18)");
    expect(hm(65 * 60_000, "uk")).toBe("1 год 5 хв");
  });

  it("status reply in Ukrainian", () => {
    seedInverter(85, 1200);
    const s = statusText(T + 60_000, "uk");
    expect(s).toContain("Світла <b>немає</b>"); // seeded inverter reads 2.7 V / 0 Hz, but no grid_state yet → from reading
    expect(s).toContain("споживання 1,2 кВт");
    expect(s).not.toContain("NaN");
  });

  it("each chat gets its own language; /lang switches it", async () => {
    pushEvent(db, "soc_low", { soc: 18, threshold: 20 }, T);
    const { tg, sent, queueUpdates } = fakeTg();
    const bot = new CommandBot(db, tg, opts(["111", "222"], T + 60_000, "uk"));
    queueUpdates([msg(222, "/lang en")]);
    await bot.pollOnce();
    expect(sent.at(-1)!.text).toContain("Language set: English");
    await new Notifier(db, tg, opts(["111", "222"], T + 60_000, "uk")).drain();
    expect(sent.find((m) => m.chat === "111" && m.text.includes("Низький заряд батареї: 18%"))).toBeTruthy();
    expect(sent.find((m) => m.chat === "222" && m.text.includes("Battery low: 18%"))).toBeTruthy();
  });

  it("plain /lang toggles; /start picks the Telegram app language for a new chat", async () => {
    const { tg, sent, queueUpdates } = fakeTg();
    const bot = new CommandBot(db, tg, opts(["111", "333"], T, "uk"));
    queueUpdates([msg(111, "/lang")]);
    await bot.pollOnce();
    expect(sent.at(-1)!.text).toContain("English");
    queueUpdates([msg(111, "/lang")]);
    await bot.pollOnce();
    expect(sent.at(-1)!.text).toContain("українська");
    queueUpdates([msg(333, "/start", "en-US")]);
    await bot.pollOnce();
    expect(sent.at(-1)!.text).toContain("Deye station bot");
  });

  it("strangers get the setup reply in their app language", async () => {
    const { tg, sent, queueUpdates } = fakeTg();
    queueUpdates([msg(999, "/start", "uk")]);
    await new CommandBot(db, tg, opts(["111"], T, "en")).pollOnce();
    expect(sent[0].text).toContain("Це приватний бот");
    expect(sent[0].text).toContain("<code>999</code>");
  });

  it("command menus exist in both languages with the same commands", () => {
    const uk = CommandBot.commands("uk").map((c) => c.command);
    expect(uk).toEqual(CommandBot.commands("en").map((c) => c.command));
    expect(uk).toContain("lang");
    expect(CommandBot.commands("uk")[0].description).toMatch(/[а-яіїєґ]/i);
  });
});

describe("welcome message for newly added chats", () => {
  const msg = (chat: number, text: string, language_code?: string): TgUpdate => ({
    update_id: 1,
    message: { message_id: 1, chat: { id: chat, type: "private" }, from: { id: chat, language_code }, text },
  });

  it("welcomes a chat once, in the language it used when asking for its id", async () => {
    seedInverter();
    const { tg, sent, queueUpdates } = fakeTg();
    // Before being allowed: /start from a Ukrainian app gets the chat id and its language is remembered.
    queueUpdates([msg(555, "/start", "uk")]);
    await new CommandBot(db, tg, opts(["111"], T, "en")).pollOnce();
    welcomed("111");
    // The id is added to .env and the worker restarts.
    const n = new Notifier(db, tg, opts(["111", "555"], T, "en"));
    await n.drain();
    const w = sent.filter((m) => m.chat === "555");
    expect(w).toHaveLength(2); // setup reply + welcome
    expect(w[1].text).toContain("Вітаю!");
    expect(w[1].text).toContain("/status");
    expect(w[1].text).toContain("Батарея");
    await n.drain();
    expect(sent.filter((m) => m.chat === "555")).toHaveLength(2); // not repeated
    expect(sent.filter((m) => m.chat === "111")).toHaveLength(0);
  });

  it("retries after a network error; a chat that never pressed Start is skipped without looping", async () => {
    const { tg, sent, failWith } = fakeTg();
    let now = T;
    const n = new Notifier(db, tg, { ...opts(["111", "222"], T, "en"), now: () => now });
    failWith(new TelegramError("sendMessage: network error", null));
    await n.drain();
    expect(sent).toHaveLength(0);
    now += 10_000;
    failWith(null); // 111 ok
    failWith(new TelegramError("sendMessage: 403 Forbidden: bot can't initiate conversation with a user", 403));
    await n.drain();
    now += 10_000;
    await n.drain();
    expect(sent.map((m) => m.chat)).toEqual(["111"]);
    expect(kvGet<string[]>(db, "telegram_welcomed_chats")).toEqual(["111", "222"]);
  });

  it("an allowed chat's /start counts as the welcome; removing and re-adding welcomes again", async () => {
    const { tg, sent, queueUpdates } = fakeTg();
    queueUpdates([msg(111, "/start", "en")]);
    await new CommandBot(db, tg, opts(["111"], T, "en")).pollOnce();
    await new Notifier(db, tg, opts(["111"], T, "en")).drain();
    expect(sent).toHaveLength(1); // only the /start reply
    await new Notifier(db, tg, opts(["222"], T, "en")).drain(); // 111 removed, 222 added
    await new Notifier(db, tg, opts(["111", "222"], T, "en")).drain(); // 111 back
    expect(sent.filter((m) => m.text.includes("Welcome!")).map((m) => m.chat)).toEqual(["222", "111"]);
  });
});
