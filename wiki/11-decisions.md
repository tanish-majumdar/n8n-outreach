# 11 — Decisions

Why things are the way they are, including the paths not taken.

## Why not the previous external agent

It was opaque. You could not see what it searched, why a day returned nothing, or predict
what it would do tomorrow. Every fix was a conversation rather than a diff. The logic here
is not complicated — the value was always in owning it and being able to read a trace.

## Why not Cloudflare Workers

This was the original plan and it died on the free tier's limits: a cron-triggered Worker
gets **10ms of CPU**. The paid tier gives 30s (or 15min for schedules of an hour or more),
which is workable but still a ceiling, and Workers have no filesystem — which is what
blocked cross-run memory entirely.

EC2 removed both constraints. Memory became a JSON file, run length stopped mattering, and
Playwright became possible if page fetching ever needs a real browser.

Workers AI is still used — over its REST API, from anywhere. There is no Worker deployed
and nothing to deploy.

## Why a service instead of a cron script

The original was `node run.js` under a systemd timer. That works, but every operational
question — did it run, what did it do, run it again now — meant SSHing in and reading
`journalctl`.

Running as a service with an in-process scheduler gives one code path for scheduled,
manual and CLI runs, a dashboard and an API for triggering and inspection, run history with
full traces, and single-flight protection that a timer plus manual SSH runs cannot provide.

The cost is a process that must stay up. `Restart=always` handles that, and losing a run to
a restart is harmless because the pipeline is append-only.

## Why Bun

Runs TypeScript directly — no build step, no `dist/`, no `.js` extensions on `.ts` imports.
A built-in Jest-compatible test runner replaced Vitest, and `Bun.serve` replaced the
Node adapter. Fewer moving parts in deployment: `git pull`, `bun install`, restart.

## Why Hono over Express

Express was the first instinct and would work. Hono won on first-class TypeScript (typed
context and params, no `@types` package), a native `Bun.serve` handler, and `app.request()`
for testing without a listening socket or supertest.

The API is close enough to Express — `app.get('/x', c => c.json(...))` — that nothing is
lost in readability, which was the actual goal.

## Why the Vercel AI SDK

The honest history: this was argued against twice, then adopted on the third ask. The
argument against was that control flow here is deterministic — the model fills in steps, it
does not choose them — so an agent framework earns nothing.

That argument was right about control flow and wrong about the rest. What the SDK actually
replaced:

| Hand-rolled before | Now |
|---|---|
| `extractJSON` — strip fences, regex for the first `{`, try/catch, return null | `generateObject` with a Zod schema |
| `readContent` — handle both `{result:{choices}}` and bare completions | provider handles it |
| "the model returned a row missing `tier`" discovered at validation | schema violation caught at the call |
| bespoke retry wrapper | `maxRetries` |

Roughly 60 lines of parsing that existed only because raw JSON-mode output is unreliable.
Workers AI exposes an OpenAI-compatible endpoint, so `@ai-sdk/openai-compatible` points
straight at it.

The original argument still holds for the *loop*: `core/research.ts` is a plain `for`, not
an agent. If the model should ever decide what to do next — search again, fetch deeper,
stop — that is when tool-calling arrives, and the SDK is already in place for it.

## Why `google-auth-library` instead of hand-rolled auth

The old code signed service account JWTs by hand: base64url encoding, PEM to PKCS#8
conversion, `crypto.subtle.importKey`, `crypto.subtle.sign`, then the token exchange. About
50 lines, all security-sensitive, all a solved problem. `googleapis` proper was heavier than
needed for four operations; `google-auth-library` alone handles the token lifecycle, and its
`request()` brings retry with it.

## Why OAuth only, and no service accounts

Service accounts were the original design and the obvious choice. Google blocks them: new
organisations get `iam.disableServiceAccountKeyCreation` enforced by default, so the key
download simply fails.

Lifting the policy needs `roles/orgpolicy.policyAdmin` and re-creates exactly the risk the
policy exists to prevent — a downloadable, non-expiring private key that nobody rotates.
Supporting both paths meant two auth code paths, two sets of failure modes and two sets of
docs for one spreadsheet, so the service account path was removed entirely rather than kept
as a dormant fallback.

The cost is real: the service now acts as a human account and dies with it. The mitigation
is to authorise a dedicated `bot@` Workspace user. See
[12 — Google authentication](12-google-auth.md).

## Why `campaign_id` is also the tab name

The alternative was adding `leads_tab` and `leads_doc_id` columns to `CAMPAIGNS`. Making
the tab name *be* the identity means the existing tab needed no changes at all, and leads
tabs need no `campaign_id` column — the tab a row lives in is which campaign it belongs to.

Cost: renaming a tab orphans its rows for dedup and starts the campaign fresh. That is an
acceptable trade for an identifier nobody renames casually.

## Why dedup is global rather than per campaign

If two campaigns both researched the same organisation, the n8n workflow would spend an
Apollo credit on it and then mark the row `duplicate_contact`. Cheaper to never create the
row. This includes paused campaigns' tabs — a paused campaign may resume, and its claimed
organisations should stay claimed.

## Why append-only, columns A:K

The n8n outreach workflow owns L:AH. Writing there does not just add noise, it breaks
outreach: any `chosen_person_*` value makes n8n take its `already_enriched` branch, skipping
contact selection and its own dedup; a `status` value makes a fresh row look processed.

Append-only means nothing this service does can corrupt outreach state even if it
misbehaves badly.

## Why memory is a JSON file

A few hundred records a year. `cp` backs it up, a text editor inspects it, `rm` resets it.
No database earns its keep at that volume. Atomic write-then-rename covers the one real
risk, an interrupted write.

## Why the limit is checked last in validation

So a rejected row reports the real reason, and so a valid row rejected purely for quota
leaves its domain unclaimed for tomorrow. Checking the limit first is the obvious
implementation and it is wrong in both respects. A test pins it.

## Why two dry rounds stop the loop

One dry round can be bad luck — a query that happened to hit a saturated corner. Two in a
row means the territory is mined out, and further rounds cost real money for nothing.
Three would be defensible; one is not.

## Rejected: a queue or worker pool

Runs are daily, take minutes, and must not overlap. A single in-process flag with a 409 is
the whole requirement. A queue would add a dependency and a failure mode to solve a problem
that does not exist.

## Rejected: storing leads in a database

The spreadsheet is the interface the humans and n8n already use. A database would be a
second source of truth to reconcile.

## Open, if ever needed

- **Playwright fallback** for pages TinyFish Fetch cannot render. Unblocked by leaving
  Workers; not built because there is no evidence it is needed.
- **Tool-calling agent loop**, as above — when the model should choose the next action.
- **Per-campaign angle lists.** `DEFAULT_ANGLES` is currently global and partner-oriented;
  a campaign in a different domain would want its own.
