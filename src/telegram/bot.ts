import { type DB, kvGet, kvSet } from "@/lib/db";
import { type NightWindow, isNight } from "@/worker/jobs";
import { type TelegramApi, TelegramError, type TgMessage } from "./api";
import { type EventRow, HELP_TEXT, formatEvent, outagesText, statusText, todayText } from "./format";

const OFFSET_KEY = "telegram_update_offset";
const STARTED_KEY = "telegram_started_at";

export interface BotOptions {
  /** Allowed chat ids. Empty = setup mode: the bot only tells people their chat id. */
  chatIds: string[];
  night: NightWindow | null;
  silentAtNight: boolean;
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

  async drain(): Promise<number> {
    if (this.draining || !this.o.chatIds.length || this.now() < this.backoffUntil) return 0;
    this.draining = true;
    let sent = 0;
    try {
      const rows = this.db.prepare("SELECT id, ts, type, payload FROM events WHERE sent_at IS NULL ORDER BY id LIMIT 20").all() as EventRow[];
      const delivered = this.db.prepare("SELECT 1 FROM event_deliveries WHERE event_id = ? AND chat_id = ?");
      const markChat = this.db.prepare("INSERT OR IGNORE INTO event_deliveries(event_id, chat_id, sent_at) VALUES (?, ?, ?)");
      const markEvent = this.db.prepare("UPDATE events SET sent_at = ? WHERE id = ?");
      for (const e of rows) {
        const text = formatEvent(e, this.now());
        if (text) {
          const silent = this.o.silentAtNight && isNight(this.now(), this.o.night);
          for (const chat of this.o.chatIds) {
            if (delivered.get(e.id, chat)) continue;
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

  static readonly COMMANDS = [
    { command: "status", description: "Grid, solar, load and battery now" },
    { command: "outages", description: "Grid outages, last 7 days" },
    { command: "today", description: "Today's energy and outages" },
    { command: "help", description: "What this bot does" },
  ];

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
    const cmd = (msg.text ?? "").trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
    if (!this.o.chatIds.includes(chat)) {
      // Private bot: strangers get nothing but their own chat id (needed for setup), and only on /start.
      if (cmd === "/start") {
        this.log(`/start from chat ${chat}${msg.from?.username ? ` (@${msg.from.username})` : ""}, not in TELEGRAM_CHAT_IDS`);
        await this.tg.sendMessage(
          chat,
          `This is a private bot.\nYour chat id is <code>${chat}</code>.\nTo receive notifications, add it to <code>TELEGRAM_CHAT_IDS</code> in the server's .env.`,
        );
      }
      return;
    }
    const now = (this.o.now ?? Date.now)();
    const reply =
      cmd === "/status" ? statusText(now)
      : cmd === "/outages" ? outagesText(7, now)
      : cmd === "/today" ? todayText(now)
      : cmd === "/start" ? `${HELP_TEXT}\n\n${statusText(now)}`
      : HELP_TEXT;
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
