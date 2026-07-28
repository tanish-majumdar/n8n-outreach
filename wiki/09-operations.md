# 09 — Operations

## Daily rhythm

```
06:00 IST   this service researches and appends A:K
09:00 IST   n8n reads those rows and does outreach
```

If research is late or fails, outreach simply has fewer new rows — the two systems are not
coupled beyond the spreadsheet.

## Where to look first

```bash
systemctl status campaign-research
journalctl -u campaign-research -n 200 --no-pager
journalctl -u campaign-research --since "06:00" --no-pager
```

Under systemd the logs are JSON — pipe through `jq`, or open the dashboard, which is
usually faster. In a terminal they render as readable lines instead; force either with
`LOG_FORMAT=json` or `LOG_FORMAT=pretty`.

## Watching a run happen

At `LOG_LEVEL=info` every step is narrated with its duration, so a slow run shows you
exactly which call is slow rather than sitting silent:

```
16:14:15 info  reading control tab                          tab=CAMPAIGNS
16:14:15 info  dedup set built 412ms                        domains=118 names=118
16:14:16 info  [matchroom india] campaign start             limit=2 memory_runs=6
16:14:16 info  [matchroom india] round 1 start              round=1 angle="incubators and accelerators" need=2
16:14:19 info  [matchroom india] model wrote 3 queries 2.7s
16:14:21 info  [matchroom india] searched 1.4s              q="startup incubators bangalore" hits=8
16:14:22 info  [matchroom india] deduped search hits        hits=22 fresh=9 already_covered=13
16:14:31 info  [matchroom india] model returned rows 8.9s   rows=6
16:14:31 info  [matchroom india] round 1 kept 2             kept=Alpha, Beta rejected=4 total=2 target=2
16:14:38 info  [matchroom india] pages fetched 6.2s         requested=2 fetched=2
16:14:44 info  [matchroom india] appending rows A:K         rows=2
16:14:45 info  [matchroom india] campaign done 29.1s        kept=2 appended=2 rounds=1
```

The long waits are normally the two model calls and the page fetch. `LOG_LEVEL=debug` adds
one line per rejected row with its reason.

## Reading a run

The dashboard at `/` lists runs; clicking one shows the full trace. Or:

```bash
curl -H "authorization: Bearer $ADMIN_TOKEN" localhost:8787/api/runs
curl -H "authorization: Bearer $ADMIN_TOKEN" localhost:8787/api/runs/<id> | jq
```

The trace is per campaign, per round:

```jsonc
{ "round": 2,
  "angle": "venture capital platforms and angel networks",
  "queries": ["..."],
  "hits":  18,   // search results returned
  "fresh":  4,   // survived domain dedup
  "kept":   2,   // became rows
  "skipped": 3,  // rejected, with reasons in campaigns[].skipped
  "note":   "every hit was already covered" }
```

## Diagnosing a thin day

Work down this table using the numbers above.

| Symptom | Meaning | Action |
|---|---|---|
| `hits` is 0 across all rounds | Search is failing or the key is exhausted. Check `search_errors`. | Verify `TINYFISH_API_KEY`; check the 30 req/min limit. |
| `hits` high, `fresh` 0, `note` set | The territory is genuinely mined out. **Not a bug.** | Broaden `research_brief`, or accept fewer leads. |
| `fresh` high, `kept` 0 | Extraction is producing junk. | Read `skipped` reasons — usually "missing or unusable website" from directory/listicle URLs. |
| `kept` < limit but only 1 round ran | Round 1 satisfied the limit. Working as intended. | Nothing. |
| Lots of "already in a campaign tab" | Dedup is doing its job. | Nothing, unless it is *every* row — then see the row above. |
| `rounds_used` is 2 with both dry | Two consecutive dry rounds stopped it early. | Expected behaviour, saves money. |

The important distinction: **short** means validation rejected rows; **dry** means search
found nothing new. Short is a quality problem, dry is a coverage problem. They need
opposite fixes.

## Common failures

### `Sheets ... failed: ... (can the authorised Google account open this spreadsheet?)`

Either `MASTER_EVENTS_ID` is wrong, or the account that authorised the service cannot see
that file. Google reports both as 404, not 403, which is why the hint is appended. Run
`bun run cli check` — it prints which account is authorised.

### `invalid_grant`

The refresh token was revoked, or it expired because the OAuth consent screen is
External + Testing (7-day limit). Re-run `bun run cli auth` and set the consent screen to
Internal — see [12 — Google authentication](12-google-auth.md).

### `Duplicate active campaign_id: x`

Two rows in `CAMPAIGNS` are active with the same id. The run aborted **before writing
anything**. Fix the tab — the same condition would break the 09:00 n8n workflow.

### `CAMPAIGNS tab not found in the spreadsheet`

Wrong `MASTER_EVENTS_ID`, or the tab was renamed. Check `CAMPAIGNS_TAB`.

### Boot fails with `Configuration invalid`

Every problem is listed at once. Fix them all, then `systemctl restart`.

### Status `partial`

One campaign threw; the others completed. The error is on that campaign in the trace. The
CLI exits 2 in this case so automation can distinguish it from a total failure.

### `409 A run is already in progress`

By design — one run at a time. Two concurrent runs would build dedup from the same snapshot
and duplicate rows. Wait, or check `/api/status` for the running id.

## Running things by hand

```bash
cd ~/campaign-research

bun run cli check                    # config + Sheets access, writes nothing
bun run cli run --dry --limit=2      # full pipeline, writes nothing
bun run cli run --limit=2            # small live run
bun run cli run --json               # complete machine-readable trace
bun run cli runs                     # run history
bun run cli memory                   # what past runs learned
```

Exit codes: `0` clean, `1` the run itself failed, `2` finished but a campaign errored.

Or via the API, which is safer on a live box because it goes through the same single-flight
guard as the scheduler:

```bash
curl -XPOST localhost:8787/api/runs \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"dry":true,"limit":2,"wait":true}' | jq
```

Note the CLI runs **in its own process** and therefore does not see the service's
in-flight run. Do not run the CLI live while a scheduled run may be in progress; use the
API for live runs and keep the CLI for `--dry` and `check`.

## Pausing

- One campaign: set `active` to `FALSE` in `CAMPAIGNS`. Its tab still counts for dedup.
- Everything: `SCHEDULE_ENABLED=false` and restart — the API stays up, nothing fires.
- Hard stop: `sudo systemctl stop campaign-research`.

## Changing the schedule

Edit `SCHEDULE` / `TIMEZONE`, restart, confirm via `/api/status`. Keep it comfortably
before 09:00.

## Resetting learning

```bash
rm ~/campaign-research/state/memory.json
sudo systemctl restart campaign-research
```

Next run starts with no prior, which is exactly the state of a brand new campaign.

## What to watch

| Signal | Healthy |
|---|---|
| `/api/status` `last.status` | `ok` |
| `last.appended` | non-zero most days, trending with limits |
| `last.durationMs` | minutes, not tens of minutes |
| `partial` runs | rare and explained |
| Skip reasons | mostly "already in a campaign tab" |

A slow decline in `appended` with rising "already in a campaign tab" is the normal
saturation curve, not a fault. It is the signal to widen a `research_brief`, not to debug
the service.
