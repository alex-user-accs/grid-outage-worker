// Minimal Telegram Bot API client: just the three methods the bot needs.
// The token is part of the URL, so it is never included in errors or logs.

export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    /** Seconds to wait, from a 429 response. */
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
  /** The chat can never receive messages (bot blocked, chat not found): don't retry. */
  get permanent(): boolean {
    return this.code === 400 || this.code === 403;
  }
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string; first_name?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TelegramApiOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class TelegramApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    opts: TelegramApiOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (opts.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  }

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (e) {
      throw new TelegramError(`${method}: network error: ${(e as Error).message.replaceAll(this.token, "<token>")}`, null);
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !body.ok) {
      throw new TelegramError(`${method}: ${res.status} ${body.description ?? res.statusText}`, res.status, body.parameters?.retry_after);
    }
    return body.result as T;
  }

  sendMessage(chatId: string | number, text: string, opts: { silent?: boolean } = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_notification: !!opts.silent,
      link_preview_options: { is_disabled: true },
    });
  }

  /** Long polling: waits up to `timeoutSec` for new messages. */
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal);
  }

  setMyCommands(commands: { command: string; description: string }[]) {
    return this.call<boolean>("setMyCommands", { commands });
  }
}
