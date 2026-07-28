# Quorum v0.1.0-beta.1

First public **beta** of Quorum Community — self-hosted Contract Catalog for n8n.

## What Quorum does

Quorum watches n8n workflows against explicit contracts. You define when a workflow should report in, what counts as success or failure, and how strong the evidence needs to be. Quorum opens incidents when reality drifts from that contract and resolves them when reporting recovers.

It is open source, zero telemetry, and designed so workflow data can stay in your infrastructure.

## Included in this release

- Contract Catalog (health, evidence strength, deadlines, alert status)
- Simplified onboarding: connect n8n, select workflows by name, confirm expectations, start monitoring
- n8n API polling (URL + API key, no workflow changes)
- Push heartbeats (HMAC-signed reports from n8n)
- Incidents, webhook/SMTP alerts, and a read Incident API
- SQLite (default) and PostgreSQL migrations
- Self-hosted Docker Compose install

## Install

```bash
cp .env.example .env
# Set QUORUM_CREDENTIAL_KEK and QUORUM_SETUP_TOKEN
docker compose up --build -d
```

Open http://127.0.0.1:3000/ → `/setup` → **Set up monitoring**.

Lab stack with bundled n8n: `docker compose -f docker-compose.lab.yml up --build`.

## Tested n8n support

| Bound          | Image / version    |
| -------------- | ------------------ |
| Minimum        | `n8nio/n8n:1.95.3` |
| Current stable | `n8nio/n8n:2.31.4` |

See [examples/n8n/README.md](examples/n8n/README.md).

## Known limitations

- **Beta** — rough edges; incomplete triage UI.
- Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.
- HubSpot webinar → Zoom registrant outcome path is **Preview** only.
- Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in this Community repository.
- Full list: [docs/known-limitations.md](docs/known-limitations.md).

## Upgrade and backup warning

Before any upgrade or restore:

1. Back up the SQLite (or Postgres) data volume.
2. Store `QUORUM_CREDENTIAL_KEK` in a **separate** secret store. Encrypted credentials cannot be recovered without it.
3. Deploy the new image, confirm `GET /readyz`, then watch `GET /health/watcher`.

Wrong KEK after restore causes decrypt failures; Quorum never prints the key.

## Documentation

- [README](README.md)
- [Getting started](docs/getting-started.md)
- [Environment](docs/environment.md)
- [Push heartbeats](docs/push-heartbeats.md)
- [Incident API](docs/incident-api.md)
- [Architecture](docs/architecture.md)
- [Security](docs/security.md) · [Operations](docs/operations.md) · [Troubleshooting](docs/troubleshooting.md)
