# Deye Cloud Dashboard

A small self-hosted dashboard for a Deye solar/battery station, built on the [Deye Cloud OpenAPI](https://developer.deyecloud.com/start). It is a Next.js (React SSR) site with a background worker and SQLite, it is read-only, and it is designed to stay well inside Deye's API limits.

```
Browser ──cookie──> Next.js (SSR pages) ──reads──> SQLite (data/deye.db) <──writes── worker ──> Deye OpenAPI
```

- **Only the worker talks to Deye.** It uses one rate-limited client, so page views cost zero API calls.
- **Credentials stay on the server.** They live in `.env` and never reach the browser. The dashboard is protected by a password (argon2) and a signed httpOnly cookie.
- **Telegram-ready.** The worker writes notable changes (alerts, device offline, SOC thresholds) to an `events` table for a future bot.

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

Steady-state budget: **about 1,373 calls per day, roughly 41k per month (41% of the quota)**.

| Job | Interval |
|---|---|
| station/latest | 2 min |
| device/latest | 5 min |
| today curve | 10 min |
| alerts | 10 min |
| energy history | 1 h |
| device list | 1 h |
| lifetime | 6 h |

The exact numbers are on the API docs page.

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

## Next: Telegram bot

Add a consumer in the worker that reads `SELECT * FROM events WHERE sent_at IS NULL`, sends each event, and sets `sent_at`. The API layer does not need to change.
