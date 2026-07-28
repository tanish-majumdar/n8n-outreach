# 07 — Configuration

All configuration is environment variables, parsed and validated once at boot by
`src/config.ts` (Zod). A bad value is a **boot failure**, not a surprise at 06:00 — and the
error lists every problem at once rather than one per restart.

Two templates, because the two contexts have different rules:

| File | For | Notes |
|---|---|---|
| `.env.example` | local development | Copy to `.env`; Bun loads it automatically. Defaults to `SCHEDULE_ENABLED=false` so a stray 06:00 run never fires from your laptop into the live spreadsheet. |
| `deploy/campaign-research.env.example` | the EC2 box | Copy to `.env` on the server and `chmod 600`. Same `.env` format — the unit sets no `EnvironmentFile`; Bun loads it from the working directory. Defaults to `SCHEDULE_ENABLED=true` and `LOG_FORMAT=json`. |

Both are committed; `.env` itself is gitignored.

## Required

| Variable | Notes |
|---|---|
| `MASTER_EVENTS_ID` | The spreadsheet id from its URL. |
| `TINYFISH_API_KEY` | Search + Fetch. Free tier, 30 requests/minute. |
| `CF_ACCOUNT_ID` | Cloudflare account id. |
| `CF_AI_TOKEN` | Cloudflare API token with Workers AI access. |
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client id. See below. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret. |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | From `bun run cli auth`. |

## Google credentials

OAuth only — service account keys are not supported. Full walkthrough in
[12 — Google authentication](12-google-auth.md).

Get all three values at once:

```bash
bun run cli auth --client-id <id> --client-secret <secret>
```

Each one missing is a boot error naming itself and pointing at that command. The service
acts as the authorising Google account, so the spreadsheet needs no separate sharing — that
account simply has to be able to open it.

The refresh token is a long-lived credential covering every spreadsheet that account can
open. Treat it as a password: mode 600, never committed, never pasted into a chat or
ticket. If it leaks, revoke at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and re-run
`cli auth`.

## Optional

### Google

| Variable | Default | Meaning |
|---|---|---|
| `CAMPAIGNS_TAB` | `CAMPAIGNS` | Name of the control tab. |

### Model

| Variable | Default | Meaning |
|---|---|---|
| `CF_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | Must be a **non-reasoning** instruct model — see below. |
| `CF_STRUCTURED_OUTPUTS` | `true` | Sends the JSON schema with the request. `false` falls back to prompt-only shape enforcement and logs an AI SDK warning on every call. |
| `MAX_QUERY_TOKENS` | `4000` | Output budget for angle and query calls. |
| `MAX_EXTRACT_TOKENS` | `16000` | Output budget for extraction and grounding. |

**Do not use a reasoning model here.** GLM-4.7-Flash was the original choice and does not
work: it emits 5,000–9,000 characters of `reasoning_content` on every call, `thinking:
{type: 'disabled'}` is silently ignored by Workers AI, and enabling structured outputs makes
it reason *more*. The result is `content: null`, so extraction returns zero rows after two
to three minutes. A full run took 15 minutes and appended nothing. llama-4-scout does the
same work in ~11s.

Reached via Workers AI's OpenAI-compatible endpoint:
`https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1`. There is no Cloudflare Worker
involved and nothing to deploy there.

### Search

| Variable | Default | Meaning |
|---|---|---|
| `SEARCH_LOCATION` | *(empty)* | Two-letter country bias, e.g. `IN`. Empty means global. |

### HTTP

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Keep it as-is unless you have set `ADMIN_TOKEN`. |
| `PORT` | `8787` | |
| `ADMIN_TOKEN` | *(unset)* | Bearer token for every route except `/health`. Unset means open. |

### Schedule

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULE` | `0 6 * * *` | Standard five-field cron. |
| `TIMEZONE` | `Asia/Kolkata` | IANA name. The schedule is interpreted in this zone, so DST cannot drift it. |
| `SCHEDULE_ENABLED` | `true` | `false` gives you an API-only instance with no automatic runs. |

Must fire well before the 09:00 n8n outreach run, with room for a slow day.

### Tuning

| Variable | Default | Range | Meaning |
|---|---|---|---|
| `DEFAULT_DAILY_LIMIT` | `13` | 1–50 | Used when a campaign leaves `research_daily_limit` blank. |
| `QUERIES_PER_ROUND` | `3` | 1–10 | More queries per round costs more search calls but widens coverage. |
| `MAX_ROUNDS` | `3` | 1–10 | Hard ceiling on feedback rounds per campaign. |
| `RETRY_ATTEMPTS` | `3` | 0–10 | Retries for transient failures, all clients. |
| `RETRY_BASE_MS` | `500` | 0–60000 | Base for exponential backoff. Tests set `0`. |

Raising `QUERIES_PER_ROUND` and `MAX_ROUNDS` together is the main lever when campaigns
consistently come back short — but check the trace first, because if rounds are ending
*dry* rather than *short* the territory is exhausted and more queries will not help.

### Storage and logging

| Variable | Default | Meaning |
|---|---|---|
| `STATE_DIR` | `state` | Holds `memory.json` and `runs/`. Must be writable. Leave it at the default on the server — it resolves against the unit's `WorkingDirectory`, and `state/` is gitignored so upgrades leave it alone. |
| `RUN_HISTORY` | `60` | Run records kept before the oldest are pruned. |
| `LOG_LEVEL` | `info` | `info` narrates every step of a run. `debug` adds each rejected row and per-request logs. `silent` for tests. |
| `LOG_FORMAT` | `pretty` on a TTY, else `json` | `pretty` for reading by eye, `json` for journald and `jq`. |
| `SLACK_WEBHOOK` | *(unset)* | Posts the run summary. Failures here are logged and never fail the run. |

## Number and boolean parsing

Numbers are clamped into range rather than rejected: `PORT=99999` becomes `65535`.
Unparseable values fall back to the default. Booleans accept `1`, `true`, `yes`, `on`
case-insensitively; anything else is false.

This is deliberate — a typo in a tuning value should not take the service down at 06:00.
A missing *secret*, by contrast, always does.

## Secrets hygiene

- `~/campaign-research/.env` on the server, mode `600`.
- The refresh token lives only in that file — nowhere else on disk.
- `.gitignore` already covers `.env`, `.env.*`, `*.pem`, `*.key` and `state/`.
- The logger redacts `authorization`, `refresh_token`, `CF_AI_TOKEN`, `TINYFISH_API_KEY`
  and `ADMIN_TOKEN`, so pasting a log is safe.
- The dashboard never renders `ADMIN_TOKEN` into the page; a test asserts this.
