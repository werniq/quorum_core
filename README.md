# Quorum

Define what each critical workflow should do. Quorum checks whether it ran, whether its reported volume stayed within the expected range, and how strong the evidence actually is.

A workflow can run successfully and still process too little or too much. Quorum checks the reported number as well as the execution status.

Open source, zero telemetry, and designed so your workflow data can stay in your infrastructure.

Reliability evidence that protects client retainers and supports proactive maintenance reporting.

> What is this business supposed to be doing, is it happening, what evidence proves it, and what requires attention?

We do not need your workflow data. See [docs/privacy.md](docs/privacy.md).

**Licence:** [AGPL-3.0](LICENSE). Hosted cloud-specific proprietary services are not part of this AGPL tree unless published separately.

### What works today

**Available (self-hosted default process):**

- Contract Catalog at `/catalog` (cadence + volume-band rules on the same contract)
- Signed n8n push heartbeats
- n8n public API polling (scheduler runs in `main.ts`)
- Cadence evaluation, volume-band evaluation, incidents, alert outbox
- Incident triage fields (assignee, response targets, resolution notes) with audit events
- Heartbeat and volume evidence with this required limitation: they do not independently prove that the destination record or message arrived

**Preview:**

- HubSpot webinar registrations → Zoom webinar registrants reconciliation

**Planned:** Zapier / Make, outcome verification for all workflows

Landing draft (not a deployed site): [docs/landing.md](docs/landing.md) · [docs/landing.html](docs/landing.html)  
Claims: [docs/positioning.md](docs/positioning.md) · Pricing: [docs/pricing-strategy.md](docs/pricing-strategy.md) · Managed pilot: [docs/managed-pilot-offer.md](docs/managed-pilot-offer.md) · Facts: [docs/technical-implementation-and-assumptions.md](docs/technical-implementation-and-assumptions.md) · Release: [docs/release-decision.md](docs/release-decision.md)

## No-telemetry promise

Self-hosted Quorum:

- never phones home
- never loads remote fonts, CDNs, analytics, crash reporters, license checks, or hosted feature flags
- never requires a Quorum cloud account
- only makes outbound network calls to destinations you configure: n8n API hosts, webhook URLs, and SMTP servers

Open Network & Privacy (`/network-privacy`) for the configured allowlist and last attempt status.

## Stack

- Node.js LTS + TypeScript (strict)
- Fastify
- Drizzle ORM / Drizzle Kit (versioned migrations)
- SQLite for self-hosted (default); Postgres schema migrations retained for dialect parity
- Vitest

Architecture: [docs/architecture.md](docs/architecture.md).

## Install (Docker Compose)

```bash
cp .env.example .env
# Set QUORUM_CREDENTIAL_KEK via a secret mechanism (do not store it only next to the DB backup).
# Prefer QUORUM_SETUP_TOKEN (>= 24 characters).
docker compose up --build -d
```

Open `http://127.0.0.1:3000/`. First run:

1. Create local admin with the setup token (`QUORUM_SETUP_TOKEN` or the one-time token printed once in logs).
2. Complete onboarding (method → workflows → explicit contracts → evidence review → alert test → activate).
3. Land on the Contract Catalog (`/catalog`).

There is no default production password.

Generated setup tokens can appear in container logs. Prefer an operator-supplied `QUORUM_SETUP_TOKEN`. The token is invalidated after the first admin is created.

### Health checks

| Endpoint              | Meaning                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /readyz`         | Schema migrated and application ready                                                              |
| `GET /health/watcher` | Watcher completed a successful tick within `WATCHER_STALE_MS`                                      |
| `GET /metrics`        | Disabled by default. Enable with `METRICS_ENABLED=true` and `METRICS_AUTH_TOKEN`, or loopback only |

Configure an external uptime check on `/health/watcher`. See [docs/operations.md](docs/operations.md).

Two alert channels are recommended for critical clients. They are not required on every contract.

## Local development

```bash
npm ci
npm run typecheck
npm test
npm run release:check
npm run build
npm run dev
```

## Self-hosted verification

Full gate (format, lint, unit/integration suites, build, clean compose, restart persistence, real n8n e2e):

```bash
npm run verify:self-hosted
```

Individual stages (Node.js `.mjs` scripts; thin `.sh` wrappers for Linux CI):

| Script                           | Command                |
| -------------------------------- | ---------------------- |
| Clean compose smoke              | `npm run test:compose` |
| Restart + SQLite/KEK persistence | `npm run test:restart` |
| Real n8n push/poll e2e           | `npm run test:e2e:n8n` |

Compose uses `${QUORUM_HOST_PORT:-3000}:3000` so verification can pick a free host port. CI can run `verify:self-hosted` on a nightly schedule and/or isolate `test:compose` / `test:e2e:n8n` as Docker jobs. n8n e2e limitations: [docs/verification/n8n-e2e-limitations.md](docs/verification/n8n-e2e-limitations.md).

## Persistence and backup

Keep these separate:

- SQLite database file on its data volume
- `QUORUM_CREDENTIAL_KEK` in a secret store or separate backup medium

Restore needs both. Losing the KEK makes encrypted credentials unrecoverable. The KEK must not appear in logs, health responses, or exports.

Full procedures: [docs/operations.md](docs/operations.md). Security: [docs/security.md](docs/security.md).

## Scripts

```bash
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:self-hosted
npm run test:security
npm run test:cov
npm run test:compose
npm run test:restart
npm run test:e2e:n8n
npm run verify:self-hosted
npm run security:deps
npm run release:check
npm run build
```

## Real n8n validation

See [docs/n8n-validation.md](docs/n8n-validation.md).
