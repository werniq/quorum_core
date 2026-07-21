# Quorum implementation specification

This document is for developers and coding agents working on the Quorum codebase. It states verified behavior, architecture rules, and release gates. Public product copy lives in the root [README.md](../../README.md).

Writing style: short sentences, concrete behavior, no marketing language.

## Product decisions (do not contradict in code or copy)

- Quorum checks workflows against explicit contracts; the Contract Catalog (`/catalog`) is the primary product surface.
- Heartbeat evidence means a signed execution was reported. It does not prove destination delivery.
- HubSpot webinar registrations to Zoom registrants is the first named outcome path, labeled **Preview**.
- Self-hosted Community code in this tree is **AGPL-3.0**.
- Hosted SaaS and Stripe packaging are **not** shipped from this Community tree. Do not reintroduce them without an explicit product decision.
- Zapier and Make are **Planned**.
- Public copy must not claim prevention or verification of all n8n workflows. Enforced by `src/product/positioning.ts` and `tests/release/positioning.test.ts`.

## Architecture

```text
src/domain/          cadence, incidents, evidence, outcome rules
src/product/         positioning, feature matrix (no domain imports from here into domain)
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
- Self-hosted edition has zero telemetry and no undeclared egress ([docs/privacy.md](../privacy.md)).
- Watcher liveness is exposed at `GET /health/watcher`; external uptime checks must use it.

Default self-hosted process (`src/main.ts`):

1. HTTP push heartbeats and UI
2. Watcher timer evaluates cadence and opens or resolves silent absence
3. Outbox timer delivers alerts
4. Poll scheduler claims due n8n poll workflows and ingests executions
5. Graceful shutdown clears timers and closes the DB

Worker claims use database rows with TTL. Two processes cannot hold the same active claim while the TTL is valid.

## Verified implementation facts

| Fact | Code | Tests |
| ---- | ---- | ----- |
| SQLite runtime starts migrations, watcher, outbox, n8n poll scheduler | `src/main.ts` | `tests/n8n/poll-scheduler.test.ts`, integration suites |
| Push heartbeat HMAC ingest | `ingest-heartbeat.ts`, `heartbeat-hmac.ts` | `tests/ingestion/*` |
| Cadence watcher with DB claims | `run-watcher.ts` | `tests/watcher/*` |
| Outbox delivery with claim TTL | `process-outbox.ts` | `tests/integration/*` |
| n8n poll scheduler claims workflows | `run-poll-scheduler.ts` | `tests/n8n/poll-scheduler.test.ts` |
| Catalog default authenticated route | `ui.ts` redirect `/` to `/catalog` | `tests/ui/catalog-product-ux.test.ts` |
| JSON APIs resolve tenant server-side | `resolve-tenant.ts`, `app.ts` | `tests/security/json-api-tenant-trust.test.ts` |
| `/metrics` disabled by default | `app.ts`, env `METRICS_*` | `tests/security/observability-and-hardening.test.ts` |
| Setup token at least 24 chars; consumed after first admin | `sqlite-auth-repositories.ts` | `tests/self-hosted/privacy-and-auth.test.ts` |
| Positioning outside domain | `src/product/*`, `src/release/*` | `tests/release/positioning.test.ts` |

## Preview and planned

**Preview:** HubSpot to Zoom outcome reconciliation; agency retainer reports on legacy paths if present in forks.

**Planned:** Zapier / Make connectors; outcome verification for all n8n workflows; published `quorum-sdk` package (HMAC helpers live in-app today).

## Known gaps (implementation)

- Metrics on Compose with `HOST=0.0.0.0` stay closed unless `METRICS_ENABLED=true` and a token or loopback client is used.
- Volume rules are evaluated by the watcher but not yet configurable in the Protect wizard UI.
- Full incident triage UI is incomplete; fields exist in the database.
- Shorter e2e (`npm run test:e2e:n8n`) does not wait a full minute for silent absence; use `npm run test:e2e:n8n:real` for wall-clock absence.
- n8n e2e may document execute-API gaps on the pinned image; see [docs/verification/n8n-e2e-limitations.md](../verification/n8n-e2e-limitations.md).

Full product limitations: [docs/verification/known-limitations.md](../verification/known-limitations.md).

## Verification commands

Run from a clean install when validating releases:

```bash
rm -rf node_modules
npm ci
npm run verify:self-hosted
```

Real n8n validation with wall-clock silent absence, poll bind, and resolution outbox:

```bash
npm run test:e2e:n8n:real
```

Stage breakdown inside `verify:self-hosted`:

- `format:check`, `lint`, `typecheck`
- `npm test` (full unit suite)
- `test:integration`, `test:repository`, `test:migrations`, `test:security`, `test:cov`
- `build`
- `test:compose` (clean Docker project, setup, login, catalog, `/readyz`, `/health/watcher`)
- `test:restart` (persistence, wrong KEK returns 401, no KEK in logs)
- `test:e2e:n8n` (containerized n8n, HMAC, auth, idempotency, poll UI)

Do not weaken or skip tests to make gates pass.

Latest verification packet: [docs/verification/release-verification.md](../verification/release-verification.md).  
Historical July 2026 evidence: [docs/archive/2026-07-release-validation/](../archive/2026-07-release-validation/).

## Release decisions

| Edition | Decision |
| ------- | -------- |
| Self-hosted Community (design partners) | **CONDITIONAL GO** when gates above are green and owner soak checklist is complete |
| Hosted SaaS production | **NO-GO** in this repository |

Machine-readable readiness: `src/release/customer-readiness.ts`.  
Release summary: [docs/release-decision.md](../release-decision.md).

## UI preview and README screenshots

Static HTML previews for UX review:

```bash
npx tsx scripts/generate-ui-previews.mjs
```

Regenerate PNGs for the root README (requires `playwright` dev dependency):

```bash
node scripts/capture-readme-screenshots.mjs
```

Output: `docs/screenshots/*.png` from generated `docs/verification/ui-preview/*.html` (gitignored; regenerate locally).

## Related docs

- [architecture.md](../architecture.md)
- [operations.md](../operations.md)
- [security.md](../security.md)
- [positioning.md](../positioning.md)
- [archive/2026-07-release-validation/](../archive/2026-07-release-validation/) (historical audits and raw evidence)

## Traceability (high level)

| ID | Claim | Status |
| -- | ----- | ------ |
| A-poll | n8n polling in default runtime | Verified |
| A-metrics | Metrics not public by default | Verified |
| A-hmac | Keyed identifier HMAC for outcome matching | Verified |
| A-licence | AGPL-3.0 | Verified |
| A-positioning | Product copy outside domain layer | Verified |
| A-pg | Postgres production SaaS | Not in Community tree |
| A-saas-auth | Hosted session auth | Not in Community tree |
