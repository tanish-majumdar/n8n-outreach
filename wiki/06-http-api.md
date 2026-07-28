# 06 — HTTP API

Hono, served by `Bun.serve` on `HOST:PORT` (default `127.0.0.1:8787`).

## Authentication

If `ADMIN_TOKEN` is set, every route except `/health` requires:

```
Authorization: Bearer <ADMIN_TOKEN>
```

If it is unset, **every route is open** and the service logs a warning at boot. That is
only acceptable while `HOST` stays `127.0.0.1`. Anyone who can reach the port can trigger
runs that spend money and write to your spreadsheet — so if you bind to `0.0.0.0`, set a
token. See [09 — Operations](09-operations.md) for reaching it remotely without exposing
it.

## Routes

### `GET /health`

Public, no auth. For load balancers and uptime checks.

```json
{ "ok": true, "service": "campaign-research", "now": "2026-07-27T06:00:00.000Z" }
```

### `GET /`

The dashboard — one self-contained HTML page, no build step and no external requests. Shows
current status, run history, a trigger button, and the full JSON trace of any run you click.

If a token is configured, paste it into the token box; it is kept in `localStorage` and
never rendered into the page source.

### `GET /api/status`

```json
{
  "running": null,
  "schedule": { "cron": "0 6 * * *", "timezone": "Asia/Kolkata" },
  "spreadsheet": "17i2-...",
  "model": "@cf/zai-org/glm-4.7-flash",
  "last": {
    "id": "20260727060000-a1b2c3",
    "status": "ok",
    "dry": false,
    "trigger": "schedule",
    "startedAt": "2026-07-27T06:00:00.000Z",
    "finishedAt": "2026-07-27T06:04:12.000Z",
    "durationMs": 252000,
    "appended": 11,
    "summary": "campaign research 2026-07-27T06:00:00.000Z\n  matchroom india: 11 appended, 4 skipped"
  }
}
```

`running` is non-null while a run is in flight. `schedule` is `null` when
`SCHEDULE_ENABLED=false`.

### `POST /api/runs`

Trigger a run.

```jsonc
{
  "dry":   false,   // read everything, write nothing
  "limit": null,    // 1..50, overrides research_daily_limit for every campaign
  "wait":  false    // block until the run finishes
}
```

| Response | When |
|---|---|
| `202` + `{id, status, startedAt}` | started in the background (`wait: false`) |
| `200` + the full `RunRecord` | finished (`wait: true`) |
| `400` | `limit` outside 1..50, or a malformed body |
| `409` + `{error, runId}` | a run is already in progress |

A full run can take minutes. Prefer the default `wait: false` and poll `/api/status`, or
raise your client timeout — `Bun.serve` is configured with a 255s idle timeout, which a
long `wait: true` run can still exceed.

```bash
curl -XPOST localhost:8787/api/runs \
  -H 'authorization: Bearer $ADMIN_TOKEN' -H 'content-type: application/json' \
  -d '{"dry":true,"limit":2,"wait":true}'
```

### `GET /api/runs`

Run history, newest first, **without** the full trace — this is the index, not the data.

```json
{ "runs": [ { "id": "...", "status": "ok", "dry": false, "trigger": "schedule",
              "startedAt": "...", "finishedAt": "...", "durationMs": 252000,
              "appended": 11, "summary": "..." } ] }
```

Statuses: `running`, `ok`, `partial` (a campaign errored), `failed` (the run itself threw).

### `GET /api/runs/:id`

One run in full, including `result.campaigns[].trace` — every round, its angle, its
queries, hit counts, fresh counts, kept counts, and every rejection with its reason. This
is what to read when a day looks thin.

`404` for an unknown id. Ids are validated against `^[\w.:-]+$`, so path traversal is not
possible.

### `GET /api/campaigns`

What the service currently thinks the `CAMPAIGNS` tab says — the parsed view, including
whether each leads tab exists yet.

```json
{ "campaigns": [ { "campaign_id": "matchroom india", "tab": "Matchroom India",
                   "research_brief": "...", "research_daily_limit": 13,
                   "research_ready": true, "tab_exists": true } ] }
```

Useful for confirming that an `active` value is being read the way you meant it.

### `GET /api/memory`

The learned digest per campaign. See [04 — Memory](04-memory.md).

```json
{ "runs_recorded": 42,
  "campaigns": [ { "campaign_id": "matchroom india", "runs_considered": 14,
                   "productive": [ { "q": "...", "kept": 9, "uses": 4 } ],
                   "barren": [ "..." ] } ] }
```

## Errors

Every error is JSON: `{ "error": "..." }`, with `runId` added on a 409. Unknown routes
return `404 {"error":"not found"}` rather than HTML.
