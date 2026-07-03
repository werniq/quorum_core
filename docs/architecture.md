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

Rules:

- Domain must not import Fastify, Drizzle, database drivers, SMTP, webhook clients, or system time.
- All time-dependent domain logic uses an injected `Clock`.
- Schema changes ship only as versioned Drizzle migrations (no production auto-sync).
- Self-hosted edition has zero telemetry and no undeclared egress (see `docs/privacy.md`).
- Hosted n8n polling uses HTTPS-only egress with DNS/IP checks, redirect re-validation,
  timeouts, and response-size limits. Private/link-local/metadata destinations are rejected.
  Private n8n instances use push heartbeats in v1.
- Watcher liveness is exposed at `GET /health/watcher` and must be monitored by an external
  uptime check; the endpoint is non-200 when evaluations are stale.
