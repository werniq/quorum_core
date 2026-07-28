# Quorum

Define what each critical workflow should do. Quorum checks whether it ran, whether its reported volume stayed within the expected range, and how strong the evidence actually is.

Quorum watches n8n workflows against explicit contracts. You define when a workflow should report in, what counts as success or failure, and how strong the evidence needs to be. Quorum opens incidents when reality drifts from that contract and resolves them when reporting recovers.

n8n can show a green execution while the business outcome is wrong — or a workflow can stop entirely and nothing tells you the process is down. Quorum is a self-hosted Contract Catalog with polling, push heartbeats, incidents, and alerts.

Open source, zero telemetry, and designed so your workflow data can stay in your infrastructure. Reliability evidence that protects client retainers and supports proactive maintenance reporting.

Quorum shows what your n8n workflows are expected to do, whether reported volume stayed inside declared bands, and alerts you when they fail, stop reporting, or produce an unacceptable result.

[![Quorum product demo](docs/demo/quorum-demo.gif)](docs/demo/quorum-demo.mp4)

## Features

- **Contract Catalog** — health, evidence strength, deadlines, and alert status in one place
- **n8n polling** — import finished executions with a URL + API key (no workflow changes)
- **Push heartbeats** — signed reports from n8n for richer execution detail
- **Incidents and alerts** — silent absence, hard failures, volume drift; webhook or SMTP delivery
- **Simplified onboarding** — connect n8n, select workflows by name, confirm expectations, start monitoring

## Beta status

Quorum Community is **beta** software for self-hosted design partners. Expect rough edges and the gaps in [limitations](#limitations). **Hosted multi-tenant SaaS is not available** from this repository.

**Licence:** [Apache-2.0](LICENSE) — Quorum Community only. Quorum Cloud (hosted SaaS) is separate proprietary code outside this tree.

## Quick start (Docker)

Published image: [`qniw984/quorum:0.1.0-beta.2`](https://hub.docker.com/r/qniw984/quorum/tags)

```bash
docker pull qniw984/quorum:0.1.0-beta.2
cp .env.example .env
# Set QUORUM_CREDENTIAL_KEK (min 16 chars) and QUORUM_SETUP_TOKEN (min 24 chars when auth is on)
docker compose up -d
```

`docker-compose.yml` defaults to that image. To build from this repo instead: `docker compose up --build -d`.

Open [http://127.0.0.1:3000/](http://127.0.0.1:3000/), create the admin at `/setup`, then open **Set up monitoring**.

Environment details: [docs/environment.md](docs/environment.md). Lab stack with bundled n8n: `docker compose -f docker-compose.lab.yml up --build` (see [docs/getting-started.md](docs/getting-started.md)).

## Onboarding

Use **Set up monitoring** (`/onboarding`):

1. Create or select a client
2. Connect n8n (URL + API key) and test
3. Select workflows by name
4. Confirm monitoring expectations
5. Test alerts → **Start monitoring**

Workflows stay “Waiting for first execution” until evidence arrives. Discovery and cadence details: [docs/onboarding-discovery.md](docs/onboarding-discovery.md).

## Connect n8n

**Polling (recommended):** complete onboarding, or add a connector under **Connectors**, bind it to a workflow, and activate. No n8n workflow edits.

**Push heartbeats:** register a push workflow, issue a credential, activate monitoring, then import [examples/n8n/quorum-signed-heartbeat.json](examples/n8n/quorum-signed-heartbeat.json). Full steps, IDs, and env injection: [docs/push-heartbeats.md](docs/push-heartbeats.md) and [examples/n8n/README.md](examples/n8n/README.md).

## Security and operations

- No telemetry in self-hosted mode; session cookies and CSRF on HTML forms
- Credentials encrypted under `QUORUM_CREDENTIAL_KEK` — **back up the KEK separately from the database**
- Health: `GET /healthz`, `/readyz`, `/health/watcher` (uptime checks should use `/health/watcher`)

More: [docs/security.md](docs/security.md) · [docs/operations.md](docs/operations.md) · [docs/incident-api.md](docs/incident-api.md) · [docs/troubleshooting.md](docs/troubleshooting.md)

## Limitations

Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.

Honest gaps: incomplete triage UI, HubSpot webinar registrations → Zoom webinar registrants outcome path is **Preview** only, volume rules not fully exposed in onboarding, no hosted SaaS / billing in this Community tree. Contract Catalog, push heartbeats, and polling are **Available**. Zapier / Make and general outcome verification for all workflows are **Planned**. Full list: [docs/known-limitations.md](docs/known-limitations.md).

## Documentation

| Topic           | Link                                               |
| --------------- | -------------------------------------------------- |
| Getting started | [docs/getting-started.md](docs/getting-started.md) |
| Environment     | [docs/environment.md](docs/environment.md)         |
| Push heartbeats | [docs/push-heartbeats.md](docs/push-heartbeats.md) |
| Incident API    | [docs/incident-api.md](docs/incident-api.md)       |
| Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Architecture    | [docs/architecture.md](docs/architecture.md)       |
| Contributing    | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
| Security policy | [SECURITY.md](SECURITY.md)                         |

## Development

Requires Node **20+**.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

Full self-hosted gate: `npm run verify:self-hosted`.
