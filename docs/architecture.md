# Architecture

Quorum uses strict layer boundaries:

```text
Domain
  contracts, evidence classification, cadence, health, incidents,
  evidence-level calculation, notification policy

Application
  use cases, authorization, transactions, repositories,
  catalog read model, outbox processing

Infrastructure
  Fastify routes, Drizzle repositories, SQLite/Postgres,
  schedulers/workers, n8n adapters, connectors, notification providers

Presentation
  contract catalog, onboarding, incident/evidence views, client reports
```

Source layout (self-hosted Community):

```text
src/domain/          cadence, incidents, evidence, outcome rules
src/product/         positioning, feature matrix (not imported by domain)
src/release/         customer readiness helpers
src/application/     use cases, repository ports, schema readiness
src/infrastructure/  Fastify, Drizzle, workers, n8n adapters, alerting
src/presentation/    SSR HTML (catalog, onboarding, incidents)
src/main.ts          self-hosted SQLite runtime (default)
```

Rules:

- Domain must not import Fastify, Drizzle, database drivers, SMTP, webhook clients, or system time.
- All time-dependent domain logic uses an injected `Clock`.
- Schema changes ship only as versioned Drizzle migrations (no production auto-sync).
- Self-hosted edition has zero telemetry and no undeclared egress (see [privacy.md](./privacy.md)).
- Hosted / public n8n polling uses HTTPS-only egress with DNS/IP checks, redirect re-validation,
  timeouts, and response-size limits. Private/link-local/metadata destinations are rejected for
  hosted policy. Self-hosted Community may allow LAN `http://` n8n via `networkPolicy: self_hosted_local`
  (cloud metadata stays blocked). Push heartbeats remain the recommended path for private n8n.
- Watcher liveness is exposed at `GET /health/watcher` and must be monitored by an external
  uptime check; the endpoint is non-200 when evaluations are stale.

Default self-hosted process (`src/main.ts`):

1. HTTP push heartbeats and UI
2. Watcher timer evaluates cadence and opens or resolves silent absence
3. Outbox timer delivers alerts
4. Poll scheduler claims due n8n poll workflows and ingests executions
5. Graceful shutdown clears timers and closes the DB

Worker claims use database rows with TTL. Two processes cannot hold the same active claim while the TTL is valid.

Product claim rules live in `src/product/positioning.ts` (enforced by `tests/release/positioning.test.ts`). Limitations: [known-limitations.md](./known-limitations.md). Release gate: [release-decision.md](./release-decision.md).
