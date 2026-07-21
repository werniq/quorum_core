# Quorum

Quorum watches n8n workflows against explicit contracts. You define when a workflow should report in, what counts as success or failure, and how strong the evidence needs to be. Quorum opens incidents when reality drifts from that contract and resolves them when reporting recovers.

## The silent-failure problem

n8n can show a green execution while the business outcome is wrong: the workflow ran but sent too few rows, too many rows, or nothing at all. Worse, a workflow can stop running entirely and nothing in n8n tells you the business process is down.

Quorum is for teams running scheduled or event-driven n8n workflows who need a separate check on **whether the process is still happening on time** and **whether reported volume looks sane**. It is a self-hosted Contract Catalog with push heartbeats, optional n8n polling, incidents, and alerts.

Quorum detects:

- **Silent absence** when expected heartbeats or poll imports stop arriving
- **Hard failures** when a workflow reports failure
- **Volume drift** when reported item counts fall outside configured bands (Basic evidence only; see limitations)
- **Stale or missing evidence** relative to the contract deadline
- **Alert delivery problems** separately from workflow health

![Contract Catalog with summary stats, alert banner, and active contracts](docs/screenshots/contract-catalog.png)

## How it works

**Contracts** tie a registered workflow to a cadence, evidence level, volume rules (optional), and alert routes. The Contract Catalog is the main surface: health, evidence strength, next deadline, and alert channel status in one place.

**Push heartbeats** (recommended) are signed HTTP reports from a step at the end of your n8n workflow. Quorum verifies HMAC, timestamp, and idempotency before recording evidence.

**Polling** imports finished executions from n8n on a schedule when you prefer not to add a push step. You add an n8n connector, register the workflow with method **Connect n8n**, and bind the connector in the UI.

**Incidents** open when the watcher finds a breach: silent absence, failure status, volume out of range, and similar contract violations. Each incident has a severity and summary.

**Alerts** deliver incident and resolution events through webhook or SMTP channels you configure. Failed deliveries surface in the catalog banner and on contract cards without changing whether a contract is overdue.

**Recovery** resolves open incidents when valid evidence arrives again (for example after you fix n8n and heartbeats resume).

![Contract detail](docs/screenshots/contract-detail.png)

![Incidents](docs/screenshots/incidents.png)

![Onboarding: choose monitoring method](docs/screenshots/onboarding-method.png)

## Beta status

Quorum Community is **beta** software for self-hosted design partners. Expect rough edges, incomplete triage UI, and gaps listed below. Hosted multi-tenant SaaS is **not available** from this repository and is not production-ready.

**Licence:** [AGPL-3.0](LICENSE)

## Quick start (Docker)

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `QUORUM_CREDENTIAL_KEK` - long random secret; back it up separately from the database
- `QUORUM_SETUP_TOKEN` - at least 24 characters; used once to create the first admin

```bash
docker compose up --build -d
```

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/). If port 3000 is taken, set `QUORUM_HOST_PORT` in `.env`.

### First-time setup

1. Visit `/setup` and create the local admin with your setup token.
2. Complete onboarding: monitoring method, register workflow(s), define contract(s), review evidence, configure and test an alert channel, activate.
3. Open the Contract Catalog at `/catalog`.

There is no default password. If you omit `QUORUM_SETUP_TOKEN`, a one-time token may appear in container logs on first boot. Prefer supplying your own token.

## Connect n8n

### Push heartbeats (recommended)

1. Register the workflow in Quorum (onboarding or **Workflows**).
2. Issue a push credential for that workflow.
3. Import and wire [examples/n8n/quorum-signed-heartbeat.json](examples/n8n/quorum-signed-heartbeat.json).

On the n8n host, allow `crypto` in Code nodes and restart n8n:

```bash
NODE_FUNCTION_ALLOW_BUILTIN=crypto
```

Set on n8n (not in the exported JSON): `QUORUM_WORKFLOW_ID`, `QUORUM_KEY_ID`, `QUORUM_HMAC_SECRET`, `QUORUM_BASE_URL`. Details: [examples/n8n/README.md](examples/n8n/README.md).

### Polling

1. Add an n8n connector under **Connectors** (base URL + API key).
2. Register the workflow with monitoring method **Connect n8n**.
3. Bind the connector, define the contract, activate.

Community self-hosted builds allow LAN `http://` n8n URLs via `networkPolicy: self_hosted_local` in the default runtime.

## Alerts

Create at least one webhook or SMTP channel under **Alert channels** and route it to contracts. Use **Send test** on the channel page. Route failures appear in the catalog banner and on cards; they do not mark a contract as satisfied or overdue.

## Security

- No telemetry in self-hosted mode; no remote fonts or analytics in the UI.
- Session cookies and CSRF on HTML forms.
- Heartbeat HMAC with per-workflow credentials encrypted under `QUORUM_CREDENTIAL_KEK`.
- JSON APIs resolve the local tenant server-side; foreign tenant headers are rejected.
- Run `npm run security:deps` for a dependency audit.

More: [docs/security.md](docs/security.md). Network and privacy copy is also at `/network-privacy` in the UI.

## Backup and upgrades

**Backup:** copy the SQLite file from the Docker volume **and** store `QUORUM_CREDENTIAL_KEK` in a separate secret store. Encrypted push credentials and alert configs cannot be recovered without the KEK.

**Upgrade:** backup database and KEK, deploy the new image, confirm `GET /readyz` returns ready, then watch `GET /health/watcher`. A wrong KEK after restore causes decrypt failures; Quorum does not print the key in logs or responses.

Operations detail: [docs/operations.md](docs/operations.md).

## Health endpoints

| Endpoint              | Meaning                                      |
| --------------------- | -------------------------------------------- |
| `GET /healthz`        | Process is up                                |
| `GET /readyz`         | Migrations applied; workers allowed          |
| `GET /health/watcher` | Watcher tick fresh within `WATCHER_STALE_MS` |

Point external uptime checks at `/health/watcher`, not `/healthz` alone.

## Development

Requires Node **20+**.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Full self-hosted verification gate (unit tests, Docker compose smoke, restart persistence, n8n e2e):

```bash
npm run verify:self-hosted
```

Architecture and implementation notes for contributors and coding agents: [docs/specification/README.md](docs/specification/README.md).

## Limitations

Heartbeats and poll imports prove that **a run was reported** with the status and counts you send. They do **not** prove that a CRM row arrived, an email was delivered, or that downstream data is complete. Medium and High evidence add stronger checks where implemented; see the contract detail page.

Other honest limits:

- HubSpot to Zoom outcome reconciliation is Preview only.
- Volume rules exist in the data model; the Protect wizard does not configure them yet.
- Incident triage fields exist in the database; full triage UI is incomplete.
- Real Slack or SMTP delivery requires your credentials and a manual send test.
- Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in this Community tree.

Full list: [docs/verification/known-limitations.md](docs/verification/known-limitations.md).

Privacy: [docs/privacy.md](docs/privacy.md).
