import { type DB, kvGet, kvSet } from "@/lib/db";
import { type NightWindow, isNight } from "@/worker/jobs";
import { type TelegramApi, TelegramError, type TgMessage } from "./api";
import { type EventRow, formatEvent, helpText, liveValues, outagesText, statusText, todayText } from "./format";
import { LANGS, type Lang, T, isLang } from "./i18n";

const OFFSET_KEY = "telegram_update_offset";
const STARTED_KEY = "telegram_started_at";
const langKey = (chat: string) => `telegram_lang:${chat}`;
const WELCOMED_KEY = "telegram_welcomed_chats";

/** The chat's chosen language, else the configured default. */
export function chatLang(db: DB, chat: string, fallback: Lang): Lang {
  const v = kvGet<string>(db, langKey(chat));
  return isLang(v) ? v : fallback;
}

/** Telegram's language_code ("uk", "en-GB", …) mapped to a supported language, if any. */
const fromTelegram = (code: string | undefined): Lang | null => {
  const base = code?.toLowerCase().split("-")[0];
  return isLang(base) ? base : null;
};

export interface BotOptions {
  /** Allowed chat ids. Empty = setup mode: the bot only tells people their chat id. */
  chatIds: string[];
  night: NightWindow | null;
  silentAtNight: boolean;
  /** Language for chats that have not chosen one with /lang. */
  defaultLang: Lang;
  log?: (m: string) => void;
  now?: () => number;
}

/** Sends queued events (rows with sent_at IS NULL) in order. Called every couple of seconds by the worker. */
export class Notifier {
  private backoffUntil = 0;
  private failures = 0;
  private draining = false;

  constructor(
    private readonly db: DB,
    private readonly tg: TelegramApi,
    private readonly o: BotOptions,
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  /**
   * On the bot's very first start, events queued before it existed are marked as handled,
   * so enabling the bot does not replay a backlog of old notifications.
   */
  init(): void {
    if (kvGet<number>(this.db, STARTED_KEY)) return;
    const now = this.now();
    this.db.prepare("UPDATE events SET sent_at = ? WHERE sent_at IS NULL AND ts < ?").run(now, now - 10 * 60_000);
    kvSet(this.db, STARTED_KEY, now);
  }

  /** Welcome message for chats that appear in TELEGRAM_CHAT_IDS for the first time (or again after removal). */
  private async welcomeNewChats(): Promise<number> {
    const welcomed = new Set(kvGet<string[]>(this.db, WELCOMED_KEY) ?? []);
    const fresh = this.o.chatIds.filter((c) => !welcomed.has(c));
    // Forget chats no longer configured, so re-adding one welcomes it again.
    const keep = () => kvSet(this.db, WELCOMED_KEY, this.o.chatIds.filter((c) => welcomed.has(c)));
    if (!fresh.length) {
      if (welcomed.size !== this.o.chatIds.length || [...welcomed].some((c) => !this.o.chatIds.includes(c))) keep();
      return 0;
    }
    let sent = 0;
    for (const chat of fresh) {
      const lang = chatLang(this.db, chat, this.o.defaultLang);
      try {
        await this.tg.sendMessage(chat, `${T[lang].welcome}\n\n${helpText(lang)}\n\n${statusText(this.now(), lang)}`);
        this.log(`welcome sent to chat ${chat}`);
        sent++;
      } catch (err) {
        if (!(err instanceof TelegramError && err.permanent)) throw err; // transient: retried next cycle
        // Telegram lets a bot write only after the person pressed Start; their /start gives the same intro.
        this.log(`cannot welcome chat ${chat} (${err.message}); they need to open the bot and press Start`);
      }
      welcomed.add(chat);
      keep();
    }
    return sent;
  }

  async drain(): Promise<number> {
    if (this.draining || !this.o.chatIds.length || this.now() < this.backoffUntil) return 0;
    this.draining = true;
    let sent = 0;
    try {
      try {
        sent += await this.welcomeNewChats();
      } catch (err) {
        this.fail(err);
        return sent;
      }
      const rows = this.db.prepare("SELECT id, ts, type, payload FROM events WHERE sent_at IS NULL ORDER BY id LIMIT 20").all() as EventRow[];
      const delivered = this.db.prepare("SELECT 1 FROM event_deliveries WHERE event_id = ? AND chat_id = ?");
      const markChat = this.db.prepare("INSERT OR IGNORE INTO event_deliveries(event_id, chat_id, sent_at) VALUES (?, ?, ?)");
      const markEvent = this.db.prepare("UPDATE events SET sent_at = ? WHERE id = ?");
      for (const e of rows) {
        const live = liveValues();
        const texts = new Map<Lang, string | null>(); // each language formatted once per event
        const silent = this.o.silentAtNight && isNight(this.now(), this.o.night);
        for (const chat of this.o.chatIds) {
          if (delivered.get(e.id, chat)) continue;
          const lang = chatLang(this.db, chat, this.o.defaultLang);
          if (!texts.has(lang)) texts.set(lang, formatEvent(e, this.now(), live, lang));
          const text = texts.get(lang);
          if (text) {
            try {
              await this.tg.sendMessage(chat, text, { silent });
              markChat.run(e.id, chat, this.now());
              sent++;
            } catch (err) {
              if (err instanceof TelegramError && err.permanent) {
                // Bot blocked or chat gone: never retry this chat for this event.
                this.log(`chat ${chat} cannot receive messages (${err.message}); skipping it`);
                markChat.run(e.id, chat, this.now());
                continue;
              }
              this.fail(err);
              return sent; // keep order: retry this event first next time
            }
          }
        }
        markEvent.run(this.now(), e.id);
      }
      this.failures = 0;
      return sent;
    } finally {
      this.draining = false;
    }
  }

  private fail(err: unknown) {
    this.failures++;
    const retryAfter = err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : 0;
    const delay = Math.max(retryAfter, Math.min(5 * 60_000, 2000 * 2 ** (this.failures - 1)));
    this.backoffUntil = this.now() + delay;
    this.log(`send failed (${(err as Error).message}); retry in ${Math.round(delay / 1000)}s`);
  }

  private log(m: string) {
    (this.o.log ?? console.log)(`[telegram] ${m}`);
  }
}

/** Answers commands via long polling. Only allowed chats get data; others are told their chat id on /start. */
export class CommandBot {
  constructor(
    private readonly db: DB,
    private readonly tg: TelegramApi,
    private readonly o: BotOptions,
  ) {}

  /** Command menu in one language (registered per language so each user sees their own). */
  static commands(lang: Lang) {
    const c = T[lang].commands;
    return (["status", "outages", "today", "lang", "help"] as const).map((command) => ({ command, description: c[command] }));
  }

  async pollOnce(timeoutSec = 25, signal?: AbortSignal): Promise<void> {
    const offset = kvGet<number>(this.db, OFFSET_KEY);
    const updates = await this.tg.getUpdates(offset, timeoutSec, signal);
    for (const u of updates) {
      // Store the offset first: a message that crashes the handler must not be retried forever.
      kvSet(this.db, OFFSET_KEY, u.update_id + 1);
      if (u.message?.text) await this.handle(u.message).catch((e) => this.log(`reply failed: ${(e as Error).message}`));
    }
  }

  async handle(msg: TgMessage): Promise<void> {
    const chat = String(msg.chat.id);
    const [rawCmd, arg] = (msg.text ?? "").trim().split(/\s+/);
    const cmd = rawCmd.replace(/@.*$/, "").toLowerCase();
    if (!this.o.chatIds.includes(chat)) {
      // Private bot: strangers get nothing but their own chat id (needed for setup), and only on /start.
      if (cmd === "/start") {
        this.log(`/start from chat ${chat}${msg.from?.username ? ` (@${msg.from.username})` : ""}, not in TELEGRAM_CHAT_IDS`);
        const detected = fromTelegram(msg.from?.language_code);
        // Remembered so the welcome message (sent once the chat is allowed) uses their language.
        if (detected && kvGet(this.db, langKey(chat)) === undefined) kvSet(this.db, langKey(chat), detected);
        await this.tg.sendMessage(chat, T[detected ?? this.o.defaultLang].stranger(chat));
      }
      return;
    }
    if (cmd === "/start") {
      // A new chat starts in its Telegram app's language when we support it.
      if (kvGet(this.db, langKey(chat)) === undefined) {
        const detected = fromTelegram(msg.from?.language_code);
        if (detected) kvSet(this.db, langKey(chat), detected);
      }
      // /start already shows the intro, so no separate welcome is needed.
      const welcomed = new Set(kvGet<string[]>(this.db, WELCOMED_KEY) ?? []);
      if (!welcomed.has(chat)) kvSet(this.db, WELCOMED_KEY, [...welcomed, chat]);
    }
    if (cmd === "/lang") {
      const current = chatLang(this.db, chat, this.o.defaultLang);
      const wanted = arg?.toLowerCase() === "ua" ? "uk" : arg?.toLowerCase();
      // "/lang uk" or "/lang en" sets it; plain "/lang" toggles.
      const next: Lang = isLang(wanted) ? wanted : LANGS[(LANGS.indexOf(current) + 1) % LANGS.length];
      kvSet(this.db, langKey(chat), next);
      await this.tg.sendMessage(chat, T[next].langSet);
      return;
    }
    const lang = chatLang(this.db, chat, this.o.defaultLang);
    const now = (this.o.now ?? Date.now)();
    const reply =
      cmd === "/status" ? statusText(now, lang)
      : cmd === "/outages" ? outagesText(7, now, lang)
      : cmd === "/today" ? todayText(now, lang)
      : cmd === "/start" ? `${helpText(lang)}\n\n${statusText(now, lang)}`
      : helpText(lang);
    await this.tg.sendMessage(chat, reply);
  }

  private log(m: string) {
    (this.o.log ?? console.log)(`[telegram] ${m}`);
  }
}

/** Runs the command loop until `signal` aborts; network errors back off up to 1 min. */
export async function runCommandLoop(bot: CommandBot, signal: AbortSignal, log: (m: string) => void): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      await bot.pollOnce(25, signal);
      failures = 0;
    } catch (e) {
      if (signal.aborted) return;
      failures++;
      const delay = Math.min(60_000, 2000 * 2 ** (failures - 1));
      log(`[telegram] polling failed (${(e as Error).message}); retry in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
