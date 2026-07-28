# 01 — Overview

## What problem this solves

Matchroom runs outreach campaigns. Each campaign needs a steady supply of partner
organisations to contact. Finding them by hand is slow; the previous approach delegated it
to an external agent, which was opaque — you could not see what it searched, why it
returned nothing on a bad day, or what it would do tomorrow.

This service replaces that. It does the same job with code you own, and every decision it
makes is recorded and inspectable.

## What it does, once a day

1. Read the `CAMPAIGNS` tab. Each row is a campaign; the `campaign_id` value is also the
   name of that campaign's leads tab.
2. For every active campaign with a `research_brief`, make sure its tab exists.
3. Read **every** leads tab to build one global set of organisations already claimed.
4. For each campaign, run the research loop until it hits the daily limit or runs dry.
5. Append the survivors to that campaign's tab, columns A:K.
6. Record which search queries actually produced rows, so tomorrow starts smarter.

## What it deliberately does not do

- **It does not do outreach.** No emails, no Apollo lookups, no contact selection. That is
  the n8n workflow's job and it starts from column L.
- **It does not modify existing rows.** It only appends. Nothing it does can overwrite a
  row that outreach has already touched.
- **It does not invent facts.** Every prompt says so explicitly, and blank cells are the
  correct output when the source does not state a figure. An empty `attendance` is fine; a
  hallucinated one poisons a pitch.

## Shape of the system

It is a long-running service, not a cron script:

- an **in-process scheduler** (croner) fires the daily run,
- an **HTTP API** (Hono) lets you trigger a run, inspect history, and read traces,
- a **CLI** does the same for one-off and dry runs from a shell,
- all three call the same `runAll` function.

There is exactly one code path. A manual run at 3pm behaves identically to the scheduled
run at 6am, which is the point — you can reproduce any incident on demand.

## Cost

TinyFish Search and Fetch are free tier. The Google Sheets API is free. GLM-4.7-Flash on
Workers AI is $0.06 per million input tokens and $0.40 per million output. A full daily run
across a handful of campaigns costs cents. The EC2 instance is the only real line item.
