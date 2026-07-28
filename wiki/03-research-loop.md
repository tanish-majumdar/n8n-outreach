# 03 — The research loop

This is the part worth understanding. Everything else is plumbing.

## The problem it exists to solve

A single-shot pipeline — brief → queries → search → extract → append — works beautifully
for about a week. Then the campaign tab fills up, the same searches return the same
organisations, every hit is a duplicate, and the run appends zero rows while reporting no
error at all.

The fix is to treat a short round as **information**, not as failure. If a round came back
short, the next round is told exactly what was already burned and is pushed to search
somewhere else.

## The loop

`src/core/research.ts`, `researchCampaign()`:

```
for round in 1..MAX_ROUNDS, while kept < limit:

    angle    = ANGLES[(dayIndex + round - 1) % 7]
    feedback = round 1 ? "" : what was tried + what is covered + how many are needed

    queries  ← model.generateQueries(brief, angle, feedback, memory)
    hits     ← search each query
    fresh    ← drop any hit whose domain is already claimed
                 └─ each dropped hit's name goes into `covered`, which is feedback fuel

    if fresh is empty:
        dryRounds++;  if dryRounds >= 2: stop
        continue                                    ← never pays the extractor

    rows     ← model.extractRows(fresh, covered, need + 4)
    result   ← validateRows(rows, seen, need)
    claim(seen, result.kept)                        ← round 2 cannot re-add round 1's rows

    dryRounds = result.kept ? 0 : dryRounds + 1
```

Then, once, after the loop:

```
pages    ← fetchPages(kept websites)      batched in tens
refined  ← model.groundRows(kept, pages)
merge by org_name, only the seven groundable fields
```

## The three things that make it work

**1. The angle advances every round.** Round 2 does not get a rephrased version of round
1's query — it gets a different *category* (accelerators → VC platforms → corporate
innovation → …). A retry that only rewords the query re-mines the same ground.

**2. The temperature rises.** Round 1 runs at 0.4 because it should be on-brief. Later
rounds run at 0.8 because they need to diverge, not refine.

**3. Dedup happens before the extractor is paid.** Hits whose domain is already claimed are
dropped at the search stage. A round where everything is a duplicate costs one query call
and some search calls — never a 6000-token extraction.

## Stopping conditions

The loop stops on the first of:

| Condition | Meaning |
|---|---|
| `kept >= limit` | Got what we came for. |
| two consecutive dry rounds | The territory is exhausted; more rounds would just cost money. |
| `round > MAX_ROUNDS` | Hard ceiling, default 3. |
| model returned no queries | Recorded as `error` on the round and the loop breaks. |

A "dry round" is one that either found nothing fresh, or found fresh hits but kept zero
rows after validation.

## Validation order matters

`validateRows` checks in this exact sequence, and it is not arbitrary:

```
missing org_name
missing / unusable website
already in a campaign tab
duplicate within this batch
over daily limit          ← last
```

The limit is checked **last** so that a rejected row reports the real reason. Two
consequences:

- A thin day is explainable. `skipped` says *why* each candidate died.
- A valid row rejected purely for quota leaves its domain **unclaimed**, so tomorrow's run
  can take it. If the limit were checked first, good organisations would be silently marked
  duplicate-ish and lost forever.

This ordering was originally wrong and a test caught it. Do not "simplify" it back.

## Grounding

Search snippets are thin, so attendance figures and dates from search results alone are
unreliable. After the loop, the surviving rows' own websites are fetched as markdown and
fed back to the model, which may only adjust seven fields:

`event_type, tier, region, dates_raw, date_confidence, attendance, event_goal`

It cannot change `org_name`, `website` or `category` — those are identity, and letting the
model rewrite them would break the merge and the dedup set.

The merge is **by `org_name`**, not by position, so a model that drops or reorders rows
loses nothing. A tier that comes back as something other than T1/T2/T3 is ignored rather
than applied.

TinyFish Fetch accepts at most 10 URLs per call, so `fetchPages` batches in tens. With a
`research_daily_limit` of 13 that is two calls — a test asserts `[10, 3]`, because an
earlier version silently dropped the tail.

## Per-query attribution

Every search hit remembers the query that surfaced it. When a row survives validation, the
originating query gets the credit:

```
queryByDomain.set(domain, hit.query)      at search time
stats.get(source).kept += 1               when a row survives
```

That `{q, hits, fresh, kept}` tuple is the entire input to [memory](04-memory.md). Without
it, learning would only know "the run kept 3 rows", which is not actionable.
