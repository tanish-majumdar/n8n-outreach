# 05 — Google Sheets contract

One spreadsheet is the entire integration surface between this service and the n8n outreach
workflow. Get this page wrong and you will corrupt live outreach data.

## Tabs

| Tab | Owner | Purpose |
|---|---|---|
| `CAMPAIGNS` | you, by hand | one row per campaign |
| one tab per campaign | this service creates it | the leads for that campaign |

**The tab name is the campaign identity.** A campaign whose `campaign_id` is
`Matchroom India` has a leads tab named exactly `Matchroom India`. There is no
`leads_tab` column and there is no `campaign_id` column inside the leads tabs — the tab a
row lives in *is* which campaign it belongs to.

This is why nothing had to be added to the existing `CAMPAIGNS` tab.

Matching is case-sensitive for the tab, case-insensitive for the id. `campaign_id` is
lowercased into `campaign_id`, but `tab` keeps the original casing because that is what
Google needs.

## The `CAMPAIGNS` tab

The service reads only these columns and ignores the rest:

| Column | Required | Meaning |
|---|---|---|
| `campaign_id` | yes | the id, and the exact name of the leads tab |
| `active` | yes | `TRUE` / `yes` / `1` enables it; anything else skips it |
| `research_brief` | yes | the natural-language description of who to look for |
| `research_daily_limit` | no | leads per day, capped at 50, defaults to `DEFAULT_DAILY_LIMIT` (13) |

A row with an empty `research_brief` is reported under `not_ready` and skipped — it is not
an error, it is a campaign that has not been written yet.

**Two active rows with the same `campaign_id` abort the entire run before anything is
written.** This is the same condition that breaks the n8n workflow at 09:00, deliberately
surfaced three hours earlier.

## The leads tabs

34 columns, created by this service when a tab is missing. The split is absolute:

```
A ─────────────── K │ L ──────────────────────────────── AH
research writes     │ n8n outreach writes
this service        │ never touched by this service
```

**A:K — written here**

`org_name`, `event_name`, `website`, `event_type`, `tier`, `region`, `dates_raw`,
`date_confidence`, `attendance`, `event_goal`, `category`

**L:AH — written by n8n, never by this service**

`purpose`, `pitch_angle`, `status`, `chosen_person_name`, `chosen_person_title`,
`chosen_person_email`, `chosen_person_apollo_id`, `llm_reason`, `email_subject`,
`email_draft`, `thread_id`, `gmail_message_id`, `last_sent_date`, `followup_stage`,
`tracking_id`, `replied`, `replied_at`, `booked`, `booked_at`, `opens`, `last_open_at`,
`clicks`, `last_click_at`

### Why the split is enforced, not just documented

Writing into L:AH would actively break outreach, not merely add noise:

- Pre-filling any `chosen_person_*` column makes the n8n workflow take its
  `already_enriched` branch. It skips contact selection *and* global dedup, and emails
  whatever is in that cell.
- Writing `status` makes a fresh row look processed, so it is never picked up at all.

`rowToCells()` maps only `RESEARCH_COLUMNS`, which is `LEAD_HEADER.slice(0, 11)`, and a
test asserts the output is exactly 11 cells and contains no `status` or `chosen_person_*`
column. If you add a research column, add it before index 11 and update the n8n workflow's
column offsets in the same change.

## Append-only

The service only ever calls `values:append`. It never updates a cell and never deletes a
row. Nothing it does can overwrite outreach state, even if it misbehaves.

## Dedup is global

Before any campaign runs, **every** leads tab is read — including paused campaigns and
tabs no campaign points at any more — into one set of claimed domains and organisation
names.

This is intentional. If two campaigns both researched the same organisation, the outreach
workflow would spend an Apollo credit on it and then mark the row `duplicate_contact`. It
is cheaper to never create the row.

Within a single run, rows kept by the first campaign are claimed immediately, so the second
campaign in the same run cannot take them either.

Matching is by normalised domain (`https://WWW.Example.com/x` → `example.com`) **or**
lowercased organisation name.

## Access

The service acts as the Google account that authorised it (see
[12 — Google authentication](12-google-auth.md)), so there is no sharing step: if that
account can open the spreadsheet, so can the service. Give it Editor, not Viewer — the
service appends rows.

If the account cannot see the file, Google returns **404, not 403**, so the client appends
`(can the authorised Google account open this spreadsheet?)` to any 404 — the raw message
sends people hunting for a wrong spreadsheet id instead.

Verify with `bun run cli check`, which prints the account it is authorised as.
