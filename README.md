# campaign-research

Daily campaign-led partner research. Reads the `CAMPAIGNS` tab, researches each active
campaign, appends leads to that campaign's own tab. Runs as a service on EC2 with a built-in
scheduler, an HTTP API and a dashboard.

TypeScript on Bun. **Full documentation is in [`wiki/`](wiki/README.md).**

```
06:00 IST  scheduler ─▶ runAll ─▶ appends columns A:K
09:00 IST  n8n outreach workflow reads those rows, writes L:AH
```

## Quick start

```bash
bun install
cp .env.example .env             # fill in the secrets - Bun loads .env automatically

bun run cli check                # validate config + Sheets access
bun run cli run --dry --limit=2  # full pipeline, writes nothing
bun run start                    # scheduler + API on 127.0.0.1:8787
bun test                         # 77 tests, no network, no credentials
```

## Stack

| | |
|---|---|
| Runtime | Bun, TypeScript, no build step |
| HTTP | Hono + `Bun.serve` |
| Model | GLM-4.7-Flash on Cloudflare Workers AI, via the Vercel AI SDK |
| Search | TinyFish Search + Fetch |
| Sheets | Google Sheets v4 via `google-auth-library` |
| Schedule | croner, in-process |
| Config | Zod-validated environment |
| State | JSON files under `state/` |

## How it works

Per campaign, a feedback loop rather than a single shot:

```
round 1  brief + memory ──▶ queries ──▶ search ──▶ drop anything already in a tab
                                                      │
         still short? ◀─────────────────────────────┘
         feed back what was tried and what is covered, change angle, raise temperature
round 2  ... until the limit is met, two dry rounds, or MAX_ROUNDS

then     fetch each survivor's own page ──▶ ground attendance / dates / tier
         append A:K ──▶ record per-query yield for tomorrow
```

Everything is traced. `GET /api/runs/:id` returns every round with its angle, queries, hit
counts and every rejection with its reason.

See [wiki/03 — The research loop](wiki/03-research-loop.md).

## Documentation

| | |
|---|---|
| [01 Overview](wiki/01-overview.md) | what this is and what it deliberately does not do |
| [02 Architecture](wiki/02-architecture.md) | layers, files, concurrency, error policy |
| [03 Research loop](wiki/03-research-loop.md) | how leads are actually found |
| [04 Memory](wiki/04-memory.md) | what "it learns" means |
| [05 Sheets contract](wiki/05-sheets-contract.md) | **read before touching a column** |
| [06 HTTP API](wiki/06-http-api.md) | routes, auth, payloads |
| [07 Configuration](wiki/07-configuration.md) | every environment variable |
| [08 Deployment](wiki/08-deployment.md) | EC2 + systemd |
| [09 Operations](wiki/09-operations.md) | diagnosing a thin day |
| [10 Testing](wiki/10-testing.md) | what the suite guarantees |
| [11 Decisions](wiki/11-decisions.md) | why it is shaped this way |
| [12 Google auth](wiki/12-google-auth.md) | OAuth setup, and how to keep the token alive |

## The one rule

This service writes **columns A:K only**. `status` and every `chosen_person_*` column belong
to the n8n outreach workflow — writing them breaks outreach rather than merely adding noise.
[wiki/05](wiki/05-sheets-contract.md) explains exactly how.
