# Wiki

How this thing works, why it is shaped this way, and what to do when it misbehaves.

| Page | Read it when |
|---|---|
| [01 — Overview](01-overview.md) | You are new here, or you forgot what this service is for. |
| [02 — Architecture](02-architecture.md) | You want to know what each file does and why the layers are split that way. |
| [03 — The research loop](03-research-loop.md) | You want to understand how leads are actually found, and how the feedback loop works. |
| [04 — Memory](04-memory.md) | You want to know what "it learns" actually means. |
| [05 — Google Sheets contract](05-sheets-contract.md) | You are changing a column, a tab name, or the n8n workflow. |
| [06 — HTTP API](06-http-api.md) | You want to trigger a run, read a trace, or build something on top. |
| [07 — Configuration](07-configuration.md) | You are setting an env var and want to know what it does. |
| [08 — Deployment](08-deployment.md) | You are putting this on the EC2 box. |
| [09 — Operations](09-operations.md) | Something is broken, or the daily numbers look wrong. |
| [10 — Testing](10-testing.md) | You are changing code and need to know what the tests guarantee. |
| [11 — Decisions](11-decisions.md) | You are about to ask "why didn't they just…". |
| [12 — Google authentication](12-google-auth.md) | You are setting up credentials, or a key is being refused. |

## The 60-second version

Every morning at 06:00 IST the service reads the `CAMPAIGNS` tab of one Google
Spreadsheet. For each active campaign it searches the web, extracts candidate partner
organisations with an LLM, throws away anything already present in any campaign tab, and
appends what survives to that campaign's own tab — columns A:K only.

Three hours later an n8n workflow picks up those rows and does outreach. The two systems
share a spreadsheet and nothing else.

```
06:00  this service     writes A:K   (research)
09:00  n8n workflow     writes L:AH  (outreach)
```

That column split is the whole integration contract. See
[05 — Google Sheets contract](05-sheets-contract.md).
