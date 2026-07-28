# 04 — Memory

## What "it learns" actually means

It is not fine-tuning and it is not a vector store. It is a JSON file recording which
*query shapes* produced usable organisations, aggregated and fed back into the prompt
before the next run writes its opening queries.

That is the honest description. It is also enough to be useful, because the failure mode
being corrected is specific: the model keeps writing the same category of query and that
category stopped paying off two weeks ago.

## What is recorded

After every real run (dry runs record nothing — they wrote nothing, so they learned
nothing), one entry per campaign is appended to `state/memory.json`:

```json
{
  "date": "2026-07-27",
  "campaign_id": "matchroom india",
  "rounds": 2,
  "kept": 5,
  "queries": [
    { "q": "startup incubators bangalore",     "hits": 8, "fresh": 6, "kept": 4 },
    { "q": "top accelerator programs 2026",    "hits": 9, "fresh": 0, "kept": 0 }
  ]
}
```

- `hits` — results the search API returned
- `fresh` — how many survived domain dedup
- `kept` — how many became rows in the sheet

The gap between `hits` and `kept` is the interesting signal. The second query above is a
perfect example of a query that *looks* productive and is worthless: nine results, none new.

## What is fed back

Before round 1, the last 14 runs for that campaign are aggregated per query string and
split into two lists:

| List | Rule | Told to the model as |
|---|---|---|
| **productive** | `kept > 0`, sorted by kept-per-use | "write new queries in this spirit, do not copy them verbatim" |
| **barren** | `kept == 0` but `hits > 0` | "avoid these and close variants" |

A query with no hits at all appears in neither list — it may have been a transient search
failure, and condemning it would be wrong.

The "do not copy them verbatim" wording is deliberate. Replaying a winning query returns
the same organisations, which are now all duplicates. What we want is the *shape* —
geography, vocabulary, specificity — not the string.

## Why aggregate over 14 runs

One unlucky day should not condemn a query, and one lucky day should not enshrine one.
Aggregating by `kept / uses` across a fortnight smooths both.

## Where it lives

`$STATE_DIR/memory.json`, written atomically (write to `.tmp`, then `rename`) so a run
killed mid-write cannot leave a corrupt file. It is capped at the newest 400 run entries.

A missing file starts fresh. A **corrupt** file also starts fresh, with a warning — losing
learning is bad, but refusing to run is worse.

## Inspecting and resetting it

```bash
bun run cli memory              # human-readable digest per campaign
curl localhost:8787/api/memory  # the same thing as JSON
```

Reset the learning by deleting the file. Back it up with `cp`. It is deliberately a plain
JSON file at a volume — a few hundred records a year — where no database earns its keep.

## Interaction with the feedback loop

These are two different mechanisms and it is worth keeping them straight:

|  | [Feedback](03-research-loop.md) | Memory |
|---|---|---|
| Timescale | within one run | across runs |
| Carries | queries tried, orgs covered, how many still needed | which query shapes historically paid off |
| Injected at | rounds 2+ | round 1 only |
| Stored | no, discarded when the run ends | yes, `state/memory.json` |

Memory sets the opening move; feedback plays the rest of the game. A test asserts memory
reaches round 1 and *not* round 2 — after round 1 the live feedback is strictly better
information than a fortnight-old average.
