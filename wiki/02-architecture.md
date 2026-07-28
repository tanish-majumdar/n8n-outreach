# 02 — Architecture

## Layers

The rule is one-directional: **core never imports clients**. Core is pure logic over
interfaces; clients are the only code that talks to a network.

```
  entrypoints     main.ts (server)      cli.ts (shell)
                        │                    │
                        └────────┬───────────┘
                                 ▼
  wiring                    container.ts  ── builds every client from Config
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
  edges         server/      runner.ts     scheduler.ts
                (Hono API)   (single-flight, run records)
                                 │
                                 ▼
  core                    core/pipeline.ts       ← orchestration
                          core/research.ts       ← the round loop
                          core/campaigns.ts      ← parsing, dedup, validation
                          core/memory.ts         ← cross-run learning
                                 │
                                 ▼ (interfaces only)
  clients        SheetsClient  SearchClient  ResearchModel  MemoryStore  Notifier
                      │             │              │             │           │
                 google OAuth  TinyFish HTTP   AI SDK/GLM     JSON files   Slack
```

## Why the seam is where it is

`core/` depends on the **interfaces** in `types.ts`, never on the implementations. That
buys three things:

1. **Tests run with no network and no credentials.** The whole suite finishes in ~100ms
   because `FakeSheets` and `FakeResearch` are plain objects, not HTTP mocks.
2. **Swapping a provider is a client change.** Moving off TinyFish or off Workers AI
   touches one file and no test in `core/`.
3. **The interesting logic is testable in isolation.** Round-by-round feedback, dedup
   ordering and rejection reasons are where bugs actually live, and none of them require a
   socket to exercise.

## File by file

| File | Responsibility |
|---|---|
| `src/types.ts` | Every domain type, Zod schema, and client interface. The contract everything else agrees on. |
| `src/config.ts` | Parses and validates env into a `Config`. Throws `ConfigError` listing *all* problems at once. |
| `src/logger.ts` | Pino, with secret-bearing paths redacted. |
| `src/container.ts` | The only place that constructs real clients. |
| `src/runner.ts` | Wraps a run in a `RunRecord`: id, status, timing, summary. Enforces one run at a time. |
| `src/scheduler.ts` | Croner job. `protect: true` so an overrunning run is never doubled up. |
| `src/main.ts` | Boots config → container → scheduler → `Bun.serve`. Handles SIGINT/SIGTERM. |
| `src/cli.ts` | Commander: `run`, `memory`, `runs`, `auth`, `check`. |
| `src/core/campaigns.ts` | Domain normalisation, `CAMPAIGNS` parsing, dedup sets, row validation, cell mapping. |
| `src/core/research.ts` | The feedback loop and grounding. The heart of the system. |
| `src/core/pipeline.ts` | Preflight, global dedup, per-campaign iteration, summary. |
| `src/core/memory.ts` | Per-query yield aggregation and the prompt block it produces. |
| `src/clients/sheets.ts` | Sheets v4 via `google-auth-library` OAuth2Client. |
| `src/clients/tinyfish.ts` | Search + Fetch, with `p-retry` backoff. |
| `src/clients/model.ts` | Every prompt, and `generateObject` calls through the AI SDK. |
| `src/clients/notify.ts` | Slack webhook, failure-tolerant. |
| `src/store/memory-store.ts` | `state/memory.json`, atomic write-then-rename. |
| `src/store/run-store.ts` | `state/runs/run-*.json`, newest-first, pruned to `RUN_HISTORY`. |
| `src/server/app.ts` | Hono routes, bearer auth, error mapping. |
| `src/server/dashboard.ts` | The single-page HTML dashboard. No build step, no CDN. |

## Concurrency

Exactly one run at a time, enforced in `runner.ts` by an in-process flag. A second attempt
gets `RunInProgressError` → HTTP 409. This matters because two concurrent runs would build
their dedup sets from the same snapshot and both append the same organisations.

The scheduler additionally sets croner's `protect: true`, so if a run somehow outlasts a
day the next fire is skipped rather than queued.

This is a single-process guarantee. Do not run two instances against one spreadsheet.

## Error policy

| Failure | Behaviour |
|---|---|
| Bad config | Refuse to boot. Log every issue at once, exit 1. |
| `CAMPAIGNS` tab missing | Abort the whole run — nothing is safe to do. |
| Duplicate active `campaign_id` | Abort **before any write**. Same condition that breaks the n8n workflow, caught three hours earlier. |
| One campaign throws | Record the error on that campaign, continue with the rest, finish `partial`. |
| A search query fails | Logged into the round, the round continues with fewer hits. |
| A page fetch batch fails | Those rows stay ungrounded. Not fatal. |
| The model returns no parseable object | Treated as an empty result, not a crash. |
| Transient HTTP (429/5xx) | Retried with exponential backoff. 4xx is never retried. |
