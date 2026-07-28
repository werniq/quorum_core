# Quorum v0.1.0-beta.2

Second public **beta** of Quorum Community — self-hosted Contract Catalog for n8n.

## Highlights since v0.1.0-beta.1

- **Remove n8n connectors** from the Connectors page (unbinds workflows, clears poll checkpoints)
- **Auto-resolve** `connector_unavailable` incidents when Test connection or polling succeeds again (Catalog no longer stays on a stale “unreachable” badge while Connectors shows healthy)
- **Fixed-rate cadence activation** — onboarding sets `schedule_anchor_at` so “Start monitoring” no longer fails with a missing anchor error
- **n8n schedule inference** — day/default intervals match how n8n stores Schedule Trigger fields; workflow detail fetch for accurate cadence suggestions
- Docker Compose URL hint when n8n is unreachable from the Quorum container
- Workflows bind-actions spacing polish

## Install

### Build locally (always works)

```bash
cp .env.example .env
# Set QUORUM_CREDENTIAL_KEK and QUORUM_SETUP_TOKEN
docker compose up --build -d
```

### Pre-built image (after Docker Hub publish is configured)

```bash
export QUORUM_IMAGE=werniq/quorum:0.1.0-beta.2   # or your Docker Hub namespace
docker compose pull
docker compose up -d
```

Open http://127.0.0.1:3000/ → `/setup` → **Set up monitoring**.

Lab stack with bundled n8n: `docker compose -f docker-compose.lab.yml up --build`.

## Known limitations

Same as beta.1 — see [docs/known-limitations.md](docs/known-limitations.md). Hosted SaaS is **not** in this Community repository.

## Upgrade

1. Back up the SQLite (or Postgres) data volume and keep `QUORUM_CREDENTIAL_KEK` in a separate secret store.
2. Deploy the new image/tag, confirm `GET /readyz`, then watch `GET /health/watcher`.

## Documentation

- [README](README.md)
- [Getting started](docs/getting-started.md)
- [Environment](docs/environment.md)
- [Troubleshooting](docs/troubleshooting.md)
