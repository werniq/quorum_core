# Quorum v0.1.0-beta.5

Fifth public **beta** of Quorum Community — self-hosted Contract Catalog for n8n.

**Hosted multi-tenant SaaS is not available** from this repository.

## Docker installation

Published image: [`qniw984/quorum:0.1.0-beta.5`](https://hub.docker.com/r/qniw984/quorum/tags)

```bash
git clone https://github.com/werniq/quorum_core.git
cd quorum_core
cp .env.example .env
# Edit the required secrets: QUORUM_CREDENTIAL_KEK (min 16 chars)
# and QUORUM_SETUP_TOKEN (min 24 chars when auth is on)
docker compose up -d
```

Open http://127.0.0.1:3000/ → `/setup` → **Set up monitoring**.

Build from source (development only):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

Lab stack with bundled n8n: `docker compose -f docker-compose.lab.yml up --build`.

## Included features

- Contract Catalog (health, evidence strength, deadlines, alert status)
- Clear silence path on contract cards: **No recent execution** (warning) → **Overdue** + `silent_absence`, then recover to Healthy when executions resume (alert channel not required)
- Empty-result reports (`success` + 0 items) count as cadence evidence, open `empty_result` incidents per policy, and do not present as silent absence
- Failure heartbeats clear silence and show **Failure reported** (consecutive failures, last success, execution ref) without Overdue/silence copy
- Hard-failure incident cards with n8n links, acknowledge, recovery duration, and human-readable heartbeat history
- Simplified onboarding: connect n8n, select workflows by name, confirm expectations, start monitoring
- n8n API polling (URL + API key, no workflow changes)
- Push heartbeats (HMAC-signed reports from n8n)
- Incidents, webhook/SMTP alerts, and a read Incident API
- Soft-remove workflows, clients, and alert channels from the UI
- Remove n8n connectors from the UI; auto-resolve stale connector-unreachable incidents when connectivity recovers
- Fixed-rate cadence activation with `schedule_anchor_at`
- SQLite (default) and PostgreSQL migrations
- Self-hosted Docker Compose install

## Supported n8n versions

| Bound          | Image / version    |
| -------------- | ------------------ |
| Minimum        | `n8nio/n8n:1.95.3` |
| Current stable | `n8nio/n8n:2.31.4` |

See [examples/n8n/README.md](examples/n8n/README.md) and [docs/connect-n8n.md](docs/connect-n8n.md).

## Upgrade and backup

Before any upgrade or restore:

1. Back up the SQLite (or Postgres) data volume.
2. Store `QUORUM_CREDENTIAL_KEK` in a **separate** secret store. Encrypted credentials cannot be recovered without it.
3. Deploy `qniw984/quorum:0.1.0-beta.5` (or build from this tag), confirm `GET /readyz`, then watch `GET /health/watcher`.

Wrong KEK after restore causes decrypt failures; Quorum never prints the key.

## Known limitations

- **Beta** — rough edges; advanced triage UI (assignment, severity edits) remains incomplete.
- Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.
- HubSpot webinar → Zoom registrant outcome path is **Preview** only.
- Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in this Community repository.
- Full list: [docs/known-limitations.md](docs/known-limitations.md).

## Documentation

- [README](README.md)
- [Getting started](docs/getting-started.md)
- [Connect n8n](docs/connect-n8n.md)
- [Environment](docs/environment.md)
- [Push heartbeats](docs/push-heartbeats.md)
- [Incident API](docs/incident-api.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security policy](SECURITY.md)
