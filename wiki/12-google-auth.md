# 12 — Google authentication

This service authenticates to Google with an **OAuth refresh token**. Service account keys
are not supported — see [why](#why-not-service-accounts).

The service acts as whichever Google account authorises it. That account must be able to
open the spreadsheet; there is no separate sharing step.

## Setup

### 1. Project and API

**https://console.cloud.google.com/projectcreate** — note the **Project ID**.

**https://console.cloud.google.com/apis/library/sheets.googleapis.com** → **Enable**.

Nothing works until the Sheets API is enabled on that project.

### 2. Consent screen — set User type to Internal

**https://console.cloud.google.com/auth/overview**

This choice matters more than it looks:

| User type | Refresh token lifetime | Verification |
|---|---|---|
| **Internal** (Workspace domain only) | does not expire | none needed |
| External + **Testing** | **expires after 7 days** | none |
| External + **In production** | does not expire | may need Google review |

**Choose Internal.** You have a Workspace domain, so this is available and it is the right
answer. External + Testing is the trap: everything works, then the service dies exactly one
week later with `invalid_grant` and no obvious cause.

If you ever run this from a personal Gmail account, you must use External and then click
**Publish app** → In production.

### 3. Create a Desktop app OAuth client

**https://console.cloud.google.com/apis/credentials** → **Create credentials** → **OAuth
client ID** → **Application type: Desktop app**.

Copy the **Client ID** and **Client secret**.

Desktop clients permit loopback redirects. If the console asks for an authorised redirect
URI, add exactly:

```
http://127.0.0.1:8788/callback
```

### 4. Run the flow

```bash
bun run cli auth --client-id <id> --client-secret <secret>
```

This starts a local server on `127.0.0.1:8788`, prints a Google URL, waits for you to
approve in the browser, exchanges the code, and prints three lines:

```
Authorised as you@yourbrandmate.in. Add these three lines to your env file:

GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REFRESH_TOKEN=...
```

Use `--port` if 8788 is taken — but then add the matching redirect URI in the console
first, because Google rejects a redirect that is not registered.

### 5. Verify

```bash
bun run cli check
# authorised as: you@yourbrandmate.in
# spreadsheet ok: 4 tabs
# CAMPAIGNS: 2 rows
# model: @cf/zai-org/glm-4.7-flash
```

## Handling the refresh token

It is a **long-lived credential equivalent to that account's access to every spreadsheet
it can open**. Not scoped to one file, not expiring on its own.

- Mode 600, in `~/campaign-research/.env` on the server.
- Never committed — `.gitignore` covers `.env` and `.env.*`.
- Never pasted into a chat, a ticket, or a screenshot.
- Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) if
  it leaks, then re-run `cli auth`.

## Use a dedicated account if you can

The service is tied to a human identity. It stops working if that person leaves the
organisation, has their account suspended, changes their password in a way that triggers
re-consent, or revokes the app.

If you can spare a Workspace seat, create a `bot@yourbrandmate.in` user, give it access to
the spreadsheet, and authorise **that** account in step 4. Then a person leaving is an HR
event, not an outage.

## What runs where

`google-auth-library`'s `OAuth2Client` exchanges the refresh token for a short-lived access
token and refreshes it automatically. The service holds no other Google credential.

## Why not service accounts

The obvious choice, and it is blocked. Google now applies this organisation policy to new
orgs by default:

```
Service account key creation is disabled
Enforced organisation policy IDs: iam.disableServiceAccountKeyCreation
```

Lifting it requires `roles/orgpolicy.policyAdmin` and re-creates the risk the policy exists
to prevent: a downloadable, non-expiring private key file that no one rotates. Supporting
both paths meant two auth code paths, two sets of failure modes, and two sets of
documentation for one spreadsheet.

The trade accepted: OAuth ties the service to an account rather than to a robot identity.
The mitigation is the dedicated `bot@` user above.

## Failure reference

| Message | Cause |
|---|---|
| `GOOGLE_OAUTH_* is required (obtain it with: bun run cli auth)` | That variable is unset or empty. |
| `Google returned no refresh token` | Google issues one only on first consent. Revoke at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then re-run `cli auth`. |
| `invalid_grant` | Token revoked, or the External + Testing 7-day expiry. Re-run `cli auth`, and fix the consent screen to Internal. |
| `redirect_uri_mismatch` | The console client does not list `http://127.0.0.1:8788/callback`. |
| `404 ... (can the authorised Google account open this spreadsheet?)` | Wrong `MASTER_EVENTS_ID`, or that account has no access. |
| `Google Sheets API has not been used in project` | Step 1 skipped. |
| `access_denied` in the browser | You declined, or the consent screen is Internal and you signed in with an outside account. |

You do **not** need billing enabled, domain-wide delegation, or any project IAM role.

## Rejected: Workload Identity Federation

The keyless option Google recommends — an EC2 instance role authenticating to GCP directly,
with no long-lived credential anywhere. Genuinely the most secure choice, and
`google-auth-library` supports it.

Not used because it needs an AWS↔GCP trust pool, an IAM role mapping, and org-level
permissions — a lot of moving parts for one spreadsheet. Worth revisiting if this service
ever holds anything more sensitive.
