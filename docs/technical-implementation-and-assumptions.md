# Quorum assumptions and implementation facts

This document replaces earlier assumption lists. Every implementation claim below is tied to code and tests. Gaps are listed as Preview, Planned, limitations, or blockers. They are not described as assumptions.

Writing style: short sentences, concrete behavior, no marketing language.

---

## 1. Confirmed product decisions

- Quorum checks whether workflows match explicit contracts.
- The Contract Catalog is the primary product surface (`/catalog`).
- Heartbeat evidence means execution was reported. It does not prove destination delivery.
- HubSpot webinar registrations to Zoom webinar registrants is the first outcome path, labeled Preview.
- Self-hosted Community code in this tree is licensed **AGPL-3.0**.
- Hosted SaaS and Stripe packaging stay Preview until the Postgres runtime and session auth path are production-ready.
- Zapier and Make are Planned.
- Public copy must not claim prevention or verification of all n8n workflows. Enforced by `src/product/positioning.ts` and `tests/release/positioning.test.ts`.

---

## 2. Verified implementation facts

| Fact                                                                            | Code                                       | Tests                                                  | Default runtime                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| SQLite self-hosted entry starts migrations, watcher, outbox, n8n poll scheduler | `src/main.ts`                              | `tests/n8n/poll-scheduler.test.ts`, integration suites | Yes                                                     |
| Push heartbeat HMAC ingest                                                      | `ingest-heartbeat.ts`, `heartbeat-hmac.ts` | `tests/ingestion/*`                                    | Yes (HTTP)                                              |
| Cadence watcher with DB claims                                                  | `run-watcher.ts`                           | `tests/watcher/*`, dialect invariants                  | Yes                                                     |
| Outbox delivery with claim TTL                                                  | `process-outbox.ts`, alerting repos        | `tests/integration/*`, dialect invariants              | Yes                                                     |
| n8n poll scheduler claims workflows                                             | `run-poll-scheduler.ts`, migration `0013`  | `tests/n8n/poll-scheduler.test.ts`                     | Yes                                                     |
| Catalog default authenticated route                                             | `ui.ts` redirect `/` → `/catalog`          | `tests/ui/catalog-product-ux.test.ts`                  | Yes                                                     |
| SaaS APIs use session cookie → membership (not body `actorUserId`)              | `saas.ts`, `saas-session.ts`               | `tests/saas/hosted-agency-saas.test.ts`                | SaaS edition                                            |
| JSON catalog/incident/outcome/alert APIs resolve tenant server-side             | `resolve-tenant.ts`, `app.ts`              | `tests/security/json-api-tenant-trust.test.ts`         | Yes (self-hosted local tenant; SaaS session+membership) |
| Outcome identifier HMAC (not plain SHA-256)                                     | `match-email.ts`, `identifier-hmac.ts`     | domain + outcome tests                                 | When reconciliation runs                                |
| In-delay unmatched rows are `waiting` (stored as `ignored` in DB CHECK)         | `match-email.ts`, `run-reconciliation.ts`  | `tests/domain/reconciliation-engine.test.ts`           | Preview path                                            |
| `/metrics` disabled by default; token or loopback when enabled                  | `app.ts`, env `METRICS_*`                  | `tests/security/observability-and-hardening.test.ts`   | Default: disabled                                       |
| Setup token ≥24 chars; consumed after first admin; session rotation on login    | `sqlite-auth-repositories.ts`              | `tests/self-hosted/privacy-and-auth.test.ts`           | Yes                                                     |
| Positioning lives outside domain                                                | `src/product/*`, `src/release/*`           | `tests/release/positioning.test.ts`                    | N/A                                                     |
| Postgres SaaS smoke entry (`main-saas`)                                         | `src/main-saas.ts`, `postgres-runtime.ts`  | `tests/saas/postgres-runtime.blackbox.test.ts`         | Preview (`npm run start:saas`)                          |
| AGPL-3.0 LICENSE                                                                | `LICENSE`, `package.json` `license`        | architecture + release tests                           | N/A                                                     |

Commands used for verification (see final report for latest run):

```bash
npm run lint
npm run typecheck
npm test
npm run release:check
```

---

## 3. Preview features

- HubSpot → Zoom outcome reconciliation (named path only).
- Hosted multi-tenant SaaS entitlements and Stripe webhook sync.
- Postgres `main-saas` smoke API (agency, login, clients, workflows, incidents). Full catalog UI, watcher, outbox processor, and poll on Postgres are not complete.
- Agency retainer reports and share links on the SQLite SaaS path with session auth.

---

## 4. Planned features

- Zapier / Make connectors.
- Outcome verification for all n8n workflows.
- Full Postgres parity for catalog UI, watcher, outbox, and poll scheduler.
- Separate published `quorum-sdk` package (HMAC helpers exist inside the app only).

---

## 5. Known limitations

- Metrics on Compose with `HOST=0.0.0.0` stay closed unless `METRICS_ENABLED=true` and a token or loopback client is used.
- Two alert channels are recommended for critical clients. The product does not require two channels on every contract.
- `docs/landing.html` is a landing-page content draft in the repo. It is not a deployed marketing site.
- Cloud-specific proprietary packaging may live outside this AGPL tree later. Do not treat Stripe/SaaS Preview code as a promise that the hosted service is open source.
- Full verification evidence lives under `docs/verification/`.
- n8n e2e may fall back to host-signed push when the pinned n8n execute API is unavailable; the workflow is still created in real n8n. See `docs/verification/n8n-e2e-limitations.md`.

---

## 6. Release blockers

Cleared (must stay green):

- SaaS authorization trusting `actorUserId` in the body (fixed: session → membership).
- n8n polling not started in default process (fixed: scheduler in `main.ts`).
- Public Apache-2.0 licence (fixed: AGPL-3.0).
- Unauthenticated `/metrics` on published ports (fixed: disabled by default + token/loopback).
- JSON APIs trusting client `x-quorum-tenant-id` / `?tenantId=` without session (fixed: `resolveTrustedTenantId`).
- Missing `format:check`, in-tree CI workflow, clean Compose black-box, restart persistence script, containerized n8n e2e, conclusive HMAC mutation, ops audit coverage, waiting-as-ignored ambiguity.

Still blocking hosted production GA:

- Full Postgres runtime for catalog, watcher, outbox, and poll (smoke only today).
- Broader production Stripe Checkout UX and hardened multi-region ops.

Still blocking **broad** self-hosted GA (not design partners):

- GitHub Actions must be green on the published remote (workflow exists; not claimed as run on GitHub here).
- n8n execute-API gap on pinned image (documented fallback).

Self-hosted design-partner release: **GO** when `npm run verify:self-hosted` is green and published limitations are accepted. Hosted SaaS remains **NO-GO**.

---

## 7. Technical architecture

```text
src/domain/     cadence, incidents, evidence, outcome, billing rules
src/product/    positioning, feature matrix
src/release/    customer readiness, release decision helpers
src/application schema readiness gates, repository ports
src/infrastructure  Fastify, SQLite/Postgres, workers, connectors
src/presentation    SSR HTML
src/main.ts         self-hosted SQLite runtime
src/main-saas.ts    Preview Postgres SaaS smoke runtime
```

Data flow (self-hosted default process):

1. HTTP push heartbeats and UI.
2. Watcher timer evaluates cadence and opens/resolves silent absence.
3. Outbox timer delivers alerts.
4. Poll scheduler claims due n8n poll workflows and ingests executions.
5. Graceful shutdown clears timers and closes the DB.

Worker claims use database rows with TTL. Two processes cannot hold the same active claim while the TTL is valid. Outbox claim owner is still primarily TTL-based; concurrency tests cover contested claims.

---

## Traceability (high level)

| ID            | Claim                         | Status                         | Required action                                        |
| ------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------ |
| A-poll        | n8n polling Available         | Verified in default runtime    | Keep scheduler tests green                             |
| A-saas-auth   | Session-backed SaaS auth      | Verified on SQLite SaaS routes | Keep adversarial tests                                 |
| A-pg          | Postgres production SaaS      | Preview                        | Finish full repo port                                  |
| A-metrics     | Metrics not public by default | Verified                       | Keep METRICS_ENABLED false in Compose unless token set |
| A-hmac        | Keyed identifier HMAC         | Verified                       | Document retention for hashes                          |
| A-licence     | AGPL-3.0                      | Verified                       | Do not reintroduce Apache claims                       |
| A-positioning | Outside domain                | Verified                       | Keep imports on `src/product`                          |

See also: [positioning.md](./positioning.md), [release-decision.md](./release-decision.md), [operations.md](./operations.md), [security.md](./security.md).
