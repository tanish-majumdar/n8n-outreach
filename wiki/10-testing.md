# 10 — Testing

```bash
bun test              # 77 tests, no network, no credentials, ~100ms
bun run typecheck     # tsc --noEmit, strict
```

Both must pass before anything ships. The suite needs no API keys and makes no network
calls, so it runs anywhere including CI.

## Why it is fast

Tests target the interfaces in `types.ts`, not HTTP. `FakeSheets` is a `Map`;
`FakeResearch` is a scripted list of rounds. There is no fetch interception, no recorded
cassettes, no server to boot.

The trade-off is explicit: **client code is not covered by unit tests.** `sheets.ts`,
`tinyfish.ts` and `model.ts` are thin adapters, verified by `bun run cli check` and a live
`--dry` run instead. Bugs there are configuration bugs, which fakes cannot catch anyway.
The logic worth testing — dedup, validation ordering, the feedback loop, memory — is
covered exhaustively.

## The files

| File | Tests | Covers |
|---|---|---|
| `test/fakes.ts` | — | `FakeSheets`, `FakeResearch`, `testConfig`, `testDeps`, builders |
| `test/campaigns.test.ts` | 15 | domain normalisation, `CAMPAIGNS` parsing, dedup sets, validation, cell mapping |
| `test/memory.test.ts` | 11 | digest maths, prompt rendering, disk round-trip, corruption tolerance |
| `test/research.test.ts` | 15 | the round loop, feedback content, dry-round stopping, attribution, grounding |
| `test/pipeline.test.ts` | 13 | preflight, global dedup, dry-run isolation, per-campaign failure isolation, summaries |
| `test/server.test.ts` | 17 | auth, trigger, 409 single-flight, run history, traversal rejection, dashboard |
| `test/config.test.ts` | 6 | defaults, clamping, boolean parsing, credential resolution and rejection |

Server tests use Hono's `app.request()` — no listening socket, no supertest.

## What the tests actually guarantee

These are the invariants worth knowing, because breaking one is a production incident:

**The column contract**
- `rowToCells` emits exactly 11 cells.
- `RESEARCH_COLUMNS` contains no `status` and no `chosen_person_*`.
- A created tab gets the full 34-column header.

**Dedup**
- Rejection reasons are accurate, and the limit is checked *last*.
- A row rejected for quota leaves its domain unclaimed for tomorrow.
- Dedup is global across tabs, and within a run campaign 2 cannot take campaign 1's rows.
- A duplicate active `campaign_id` aborts before any write.

**The feedback loop**
- Round 2's prompt literally contains round 1's queries and the covered organisations.
- Round 2's angle differs from round 1's.
- Memory reaches round 1 and *not* round 2.
- Two dry rounds stop the loop early.
- Hits already covered never reach the extractor.

**Dry runs**
- Create no tabs, append nothing, and record nothing into memory.

**Isolation**
- One campaign throwing does not stop the others; the run ends `partial`.

**The API**
- A wrong or missing bearer token is 401; `/health` stays public.
- A concurrent trigger is 409.
- Run listing omits full traces; detail includes them.
- A path-traversal run id is 404, not a file read.
- The admin token never appears in the dashboard HTML.

**Grounding**
- Page fetches batch in tens (`[10, 3]` for 13 rows — an earlier version dropped the tail).
- Merging is by `org_name`, and an invalid tier is ignored rather than applied.

## Adding a test

Script the model and search together — `FakeResearch` implements both interfaces, so one
object defines a round's queries, its hits per query, and the rows the extractor returns:

```ts
const model = new FakeResearch([
  { queries: ['q1'], hits: { q1: [hit('https://a.com')] }, rows: [row('A', 'https://a.com')] },
  { queries: ['q2'], hits: { q2: [hit('https://b.com')] }, rows: [row('B', 'https://b.com')] },
]);
const { kept, trace } = await researchCampaign({ model, search: model }, campaign, options());

expect(model.queryPrompts[1]!.feedback).toContain('q1');
```

`model.queryPrompts` and `model.extractPrompts` record every request, which is how the
prompt-content assertions work. Asserting on *what reached the prompt* is the highest-value
thing to test here — most of this system's correctness is "did the feedback actually get
there".

## Regressions the suite has already caught

Kept as a warning against "simplifying" them away:

- **Limit checked before validation** — mislabelled duplicates as "over daily limit" and
  claimed domains that should have stayed available.
- **TinyFish Fetch dropping URLs past 10** — with a limit of 13, three rows silently lost
  grounding.
- **`date_confidence` defaulting** — `??` instead of `||` meant an empty string stopped
  defaulting to `unconfirmed`. Caught during the TypeScript port.
