# Deye Cloud Dashboard

A small self-hosted dashboard for a Deye solar/battery station, built on the [Deye Cloud OpenAPI](https://developer.deyecloud.com/start). It is a Next.js (React SSR) site with a background worker and SQLite, it is read-only, and it is designed to stay well inside Deye's API limits.

```
Browser ──cookie──> Next.js (SSR pages) ──reads──> SQLite (data/deye.db) <──writes── worker ──> Deye OpenAPI
```

- **Only the worker talks to Deye.** It uses one rate-limited client, so page views cost zero API calls.
- **Credentials stay on the server.** They live in `.env` and never reach the browser. The dashboard is protected by a password (argon2) and a signed httpOnly cookie.
- **Telegram-ready.** The worker writes notable changes (grid lost/restored, alerts, device offline, SOC thresholds) to an `events` table for a future bot.

## Setup

Requirements: Node.js 20 or newer. The account used here is a personal Deye account in the EU1 data center.

```bash
npm install
cp .env.example .env
npm run hash-password -- deye    # paste the output into DEYE_PASSWORD_SHA256
npm run hash-password -- admin   # paste the output into ADMIN_PASSWORD_HASH
openssl rand -base64 48          # paste into SESSION_SECRET
```

Fill in `DEYE_APP_ID`, `DEYE_APP_SECRET` (from the developer portal → your application) and `DEYE_EMAIL`.

## Run

| Command | What it does |
|---|---|
| `DEYE_MOCK=1 npm run dev` | UI work with generated demo data: **0 API calls** |
| `ALLOW_LIVE=1 npm run smoke` | First real check: at most **6 calls**. Saves redacted responses to `tests/fixtures/live/` (git-ignored) and prints the rate-limit headers |
| `npm run dev` | Web server (http://localhost:3000) and worker, live |
| `npm run build && npm start` | Production |
| `npm test` | Unit tests. They use a fake `fetch` and make no real calls |
| `npm run update-spec` | Re-downloads Deye's Swagger spec and diffs it (`-- --write` to save) |

When serving over plain HTTP on a LAN in production, set `INSECURE_COOKIE=1`. Otherwise the session cookie requires HTTPS.

## Pages

- **Dashboard:**
  - live tiles: PV, load, grid, battery and SOC;
  - today's power curve and SOC;
  - daily energy for the last 30 days and monthly energy for the last 12 months;
  - lifetime totals and alerts.
- **Devices:** online status and the raw measure points of each device.
- **API status:** calls today and this month against the caps, worker jobs, token expiry, Deye rate-limit headers, recent calls, and queued events.
- **API docs:** our annotated copy of Deye's spec (`docs/deye-openapi.json` plus `docs/annotations.ts`). It covers:
  - auth, limits, the call budget and conventions;
  - a Swagger reference for all 40 endpoints, with WRITE badges and live call counts.

  "Try it out" is disabled.

## API limits and how we stay inside them

Deye publishes these limits in its Best Practices and calls them preliminary:
- **60 requests per minute** per app; going over returns HTTP 429;
- **about 100,000 calls per month** base quota;
- polling every **1–2 minutes**.

| Guard | Setting |
|---|---|
| Evenly spaced limiter | `API_QPM=30` (half of Deye's limit) |
| Persistent call log and caps; the worker pauses when a cap is hit | `API_DAILY_CAP=3000`, `API_MONTHLY_CAP=90000` |
| Exponential backoff with jitter on 429/5xx, plus a global cooldown after a 429 | 3 retries |
| Token cached in SQLite and reused ~60 days; re-login once on 401 | — |
| Finished days, months and years are fetched once and frozen | — |
| Job last-run times persist, so restarts don't re-fire jobs | — |

Steady-state budget: **about 1,230 calls per day, roughly 37k per month (37% of the quota)**. Night hours (`NIGHT_HOURS`, default 01:00–06:00) poll more slowly.

| Job | Day | Night |
|---|---|---|
| gridWatch (`device/latest`, phase-locked) | each 2-min logger upload | 5 min |
| station/latest | 5 min (Deye caches it 5 min) | 15 min |
| today curve, alerts | 10 min | 30 min |
| gridHistory, energy, device list | 1 h | 1 h |
| lifetime | 6 h | 6 h |

The exact numbers are on the API docs page.

## Grid outage detection

Deye's "Grid disconnection / restoration" notifications exist only in the app's Message Center. They are not in the OpenAPI, and they are not alerts.

- **How it's detected:** we read the inverter's own `GridVoltage…` and `GridFrequency`. An outage reads about 2.7 V and 0 Hz.
- **Timing:** the logger uploads every 120 s, and a sample is visible about 40 s later. `gridWatch` polls right after each upload, so an outage shows up **about 1–3 min after it starts**.
- **Gap filling:** every hour, `gridHistory` checks the day's 2-min history and fills gaps from night polling or restarts. Flickers shorter than one sample (~2 min) can be missed.
- **Results:** outages are stored in `grid_outages` and shown on the dashboard. The `grid_down`, `grid_up` and `grid_outage_missed` events go to the Telegram queue.

## Layout

```
src/lib/deye/client.ts   the only path to Deye (auth, limiter, caps, backoff, call log)
src/lib/deye/mock.ts     demo data source (DEYE_MOCK=1)
src/worker/jobs.ts       what is polled and how often
src/worker/events.ts     change detection → events table (for the Telegram bot)
src/lib/repo.ts          read helpers for pages
src/app/(main)/          dashboard, devices, status, api-docs
docs/                    Deye spec + our annotations
scripts/                 hash-password, smoke, update-spec, pre-commit guard
```

The git pre-commit hook (`.githooks/`, installed by `npm install`) refuses to commit `.env`, `data/` or live fixtures.

## Telegram bot

The bot runs inside the worker and only reads the local database, so it adds **no Deye API calls**.

**What it sends:**
- grid lost or restored, including battery level and a rough estimate of how long the battery will last at the current load;
- short outages found later in the history;
- inverter alerts;
- devices going offline;
- battery thresholds.

Events are sent about 2 s after the worker queues them. During `NIGHT_HOURS` they arrive without sound (set `TELEGRAM_SILENT_AT_NIGHT=0` to turn that off).

**Commands:** `/status`, `/outages`, `/today`, `/help`.

**Setup:**
1. In Telegram, open **@BotFather** and send `/newbot`. Copy the token into `TELEGRAM_BOT_TOKEN` in `.env`.
2. The worker restarts when `.env` changes. Then send `/start` to your new bot. It is private, so it only replies with your chat id.
3. Put that id into `TELEGRAM_CHAT_IDS`. Separate several ids with commas, for example for family members.

**Behaviour to know about:**
- Anyone else who writes to the bot gets nothing except their own chat id.
- Events queued before the bot was first configured are not replayed.
- Every message is recorded per chat, so a network retry never sends the same message twice.
