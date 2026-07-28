# 08 — Deployment

Target: one small EC2 instance (`t4g.small` is plenty), Ubuntu 26.04, running the service
under systemd as the `ubuntu` login user.

There is no build step. Bun runs the TypeScript directly.

The service runs as `ubuntu` out of `~/n8n-outreach`, with secrets in a `chmod 600`
`.env` that Bun loads automatically. No service account, no `/etc` env file, no sandbox
paths to keep in sync. The trade is deliberate — see [Why not a service user](#why-not-a-service-user).

## 0. On your laptop — push the repo

The box installs by `git clone`, so the code has to be somewhere it can reach.

```bash
git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:<you>/campaign-research.git
git push -u origin main
```

Confirm nothing secret went with it — `.gitignore` covers `.env` and `state/`, but check:

```bash
git ls-files | grep -E '\.env$|^state/' || echo clean
```

## 1. Launch the instance

| | |
|---|---|
| AMI | Ubuntu 26.04 LTS, **arm64** (Canonical's official image) |
| Type | `t4g.small` — the work is network-bound, 2 GB is plenty |
| Storage | 8 GB gp3 default |
| Inbound | SSH (22) **from your IP only** |

Nothing else opens. The API stays on loopback and you reach it by tunnel.

## 2. Bun

```bash
sudo apt update && sudo apt install -y git unzip

curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
bun --version
```

`bun --version` must work **without** a path prefix before you go on. The installer appends
`~/.bun/bin` to `PATH` in `~/.bashrc`; if it didn't, do it by hand:

```bash
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
```

This matters because `bun run cli` executes the `package.json` script `bun run src/cli.ts`
in a *nested shell*, which does its own `PATH` lookup. Calling Bun by absolute path is not
enough — even `~/.bun/bin/bun run cli check` fails with `bun: command not found`, raised by
the inner shell, not the outer one. (The unit file is immune: `bun run src/main.ts` names a file, so Bun runs it
in-process without shelling out.)

Leave the binary at `~/.bun/bin/bun` — that is the path in `ExecStart`.

## 3. Code

```bash
git clone https://github.com/<you>/n8n-outreach.git ~/n8n-outreach
cd ~/n8n-outreach
bun install --production --frozen-lockfile
```

The directory name is load-bearing: `WorkingDirectory` and `ExecStart` in the unit both say
`/home/ubuntu/n8n-outreach`. Clone somewhere else and you must edit those two lines.

`state/` is created on first run, inside the repo but gitignored, so upgrades never touch it.

## 4. Google credentials

Do this **on your laptop**, not on the box — the flow needs a browser. Full walkthrough in
[12 — Google authentication](12-google-auth.md).

```bash
bun run cli auth --client-id <id> --client-secret <secret>
```

Keep the three `GOOGLE_OAUTH_*` lines it prints for step 5. There is no key file to copy.

Two things that will cost you a week if you get them wrong:

- The OAuth consent screen must be **Internal**. External + Testing expires refresh tokens
  after 7 days.
- Authorise a dedicated `bot@` Workspace account if you can spare a seat. Whoever
  authorises it is who the service acts as, and it dies when that person does.

## 5. Environment

```bash
cd ~/n8n-outreach
cp deploy/campaign-research.env.example .env
chmod 600 .env
nano .env
```

Copy the **`deploy/`** template, not the `.env.example` in the repo root — that one is for
laptops and sets `SCHEDULE_ENABLED=false`, which starts the API but never fires a run.
Confirm with `grep -E '^(SCHEDULE_ENABLED|LOG_FORMAT)=' .env`.

Fill in the three `GOOGLE_OAUTH_*` values from step 4, plus `MASTER_EVENTS_ID`,
`TINYFISH_API_KEY`, `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, and an `ADMIN_TOKEN` from
`openssl rand -hex 32`. Everything else is already set for a server.

This file holds the refresh token, so `chmod 600` is not optional.

Bun's `.env` parser strips trailing `#` comments, so a `#` inside an unquoted value
truncates it — `TOKEN=ab#cd` parses as `ab`. Quote any secret containing a `#`. Spaces need
no quoting: `SCHEDULE=0 6 * * *` is read correctly as-is.

## 6. Verify before scheduling anything

The `.env` is right there and readable by you, so this is just the CLI:

```bash
cd ~/n8n-outreach
bun run cli check
```

Expected: the authorised account, the tab count, the `CAMPAIGNS` row count and the model
id. A 404 means that account cannot open the spreadsheet. A config error lists every
variable that failed validation at once.

Then a dry run that touches nothing:

```bash
bun run cli run --dry --limit=2
```

Read the output. It prints the queries the model wrote, how many hits each returned, what
survived dedup, the rows it *would* append, and every rejection with its reason. It also
proves `state/` is writable.

## 7. Install the service

```bash
sudo cp deploy/campaign-research.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now campaign-research
systemctl status campaign-research
journalctl -u campaign-research -f
```

The unit hardcodes `ubuntu` and `/home/ubuntu` in three places. If you ever move this to an
AMI with a different login user, those are the only lines to change.

The service starts the scheduler *and* the API. There is no separate timer — the old
`campaign-research.timer` is gone, delete it if you are upgrading.

## 8. Confirm

```bash
curl localhost:8787/health

cd ~/n8n-outreach
TOKEN=$(bun -e 'process.stdout.write(process.env.ADMIN_TOKEN ?? "")')
curl -H "authorization: Bearer $TOKEN" localhost:8787/api/status
```

Read the token through Bun rather than `grep | cut`. The auth check is exact string
equality (`src/server/app.ts:24`) against the *parsed* value, and Bun strips surrounding
quotes and trailing `#` comments — so the raw file text and what the service compares
against are not always the same string. Letting Bun parse `.env` removes the discrepancy.

A `401` here is not a config failure: `requireAuth` returns early when `ADMIN_TOKEN` is
empty, so a rejection proves the service is running *and* the token loaded. It means your
shell extracted the wrong string.

`/health` needs no auth; everything under `/api/*` needs the bearer token.
`status.schedule.next` confirms the scheduler is armed — if that timestamp looks wrong,
install `tzdata` so croner can resolve `Asia/Kolkata`.

## Upgrading

```bash
cd ~/n8n-outreach
git pull
bun install --production --frozen-lockfile
sudo systemctl restart campaign-research
```

`.env` and `state/` are both gitignored, so a pull leaves them alone. A restart during a run
loses that run — it is append-only, so nothing is corrupted; whatever had already been
appended stays and the rest is simply not researched. Re-trigger it manually.

## Remote access

Keep `HOST=127.0.0.1`. To reach the dashboard from your laptop, tunnel:

```bash
ssh -L 8787:localhost:8787 ubuntu@<host>
```

Then open `http://localhost:8787`. Do not open the port in the security group — a run costs
money and writes to your spreadsheet.

## Backups

Only `state/` matters, and only for convenience:

```bash
tar czf ~/campaign-research-state-$(date +%F).tar.gz -C ~/n8n-outreach state
```

Losing it costs the learned query yields and run history. Nothing in the spreadsheet
depends on it.

## Why not a service user

An earlier version of this ran as a dedicated `research` system user, out of
`/opt/campaign-research`, with a root-owned `600` `EnvironmentFile` in `/etc` and
`ProtectSystem=strict`. It was dropped because the hardening, not systemd, was what made
deployment long: it added a `useradd`, a `chown` ordering you could get wrong, a second env
file in a second format, a `ReadWritePaths` entry that had to stay in sync with
`STATE_DIR`, and — worst — it made `cli check` unrunnable by hand, because the env file was
unreadable by the user meant to run it.

What that bought was containment if the *service* were compromised. That is not this box's
threat model: it is single-tenant, only you SSH in, and the thing the attacker wants is the
refresh token, which any shell as your login user already reads. Running as `ubuntu` puts
the token at exactly the same exposure it already has on your laptop.

The hardening that survived in the unit file — `NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=full` — is the part that costs zero setup steps. `ProtectHome` and
`ProtectSystem=strict` are deliberately absent: the code, `.env` and `state/` all live under
`$HOME`.

If you ever put this on a shared or multi-tenant box, reverse the trade — the service-user
layout is the right one there.
