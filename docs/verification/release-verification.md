# Release verification — Quorum Community

**Date:** 2026-07-31  
**Host:** Windows 11, Node v24.17.0, Docker 28.4.0 (CI on `ubuntu-latest`)  
**Package:** `quorum@0.1.0-beta.5`  
**Image:** `qniw984/quorum:0.1.0-beta.5`

Canonical packet for the latest self-hosted Community gate on **0.1.0-beta.5**, including hard-failure / silent-absence / empty-result / recovery / Catalog UI work landed after the 2026-07-21 packet.

**Decisions:** Self-hosted Community **CONDITIONAL GO** — automated gates green; owner 24–48 h soak still required. Hosted SaaS **NO-GO**.

Related: [release-decision.md](../release-decision.md) · [known-limitations.md](../known-limitations.md)

## What changed since 2026-07-21

| Area           | Verification                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Silent absence | Catalog **No recent execution** → **Overdue** + `silent_absence`, recover to **Healthy** without requiring an alert channel                 |
| Hard failure   | Failure heartbeats clear silence; Catalog shows **Failure reported** (not Overdue/silence); enriched incident cards + recovery              |
| Empty result   | `success` + 0 items → durable `empty_result`; counts as a received report for cadence; separate last-report / last-success / last-non-empty |
| UI / docs      | Lifecycle screenshot + Poll invoices walkthrough; beta feedback issue template; Quick Start uses `git clone` + Compose                      |
| CI             | Master push runs `static-and-tests` and `compose-and-e2e` (compose, restart, `test:e2e:n8n`)                                                |

## Commands run (this cycle)

| Step                | Command / evidence                                                                         | Exit / result |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| Unit suite          | `npm test` (2026-07-31)                                                                    | 0 · **322**   |
| Domain coverage     | `npm run test:cov` (2026-07-31)                                                            | 0 · ≥90% gate |
| Static release      | `npm run release:check` (2026-07-30, empty-result commit)                                  | 0             |
| GitHub CI           | [30581191752](https://github.com/werniq/quorum_core/actions/runs/30581191752) empty-result | success       |
| GitHub CI           | [30604654391](https://github.com/werniq/quorum_core/actions/runs/30604654391) beta kit     | success       |
| Incident UX tests   | silent-absence / hard-failure / catalog polish / watcher recovery (2026-07-31)             | 51 passed     |
| Real n8n wall-clock | `npm run test:e2e:n8n:real` (last full packet **2026-07-21**; see §4)                      | 0             |

## 1. Local suites (2026-07-31)

| Stage    | Result                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------- |
| test     | **322 passed**, 0 skipped (55 files)                                                           |
| test:cov | 49 domain tests; **93.34%** stmts/lines; **91.57%** branches; 100% funcs on gated domain files |
| format   | pass                                                                                           |
| lint     | pass (docs/demo kit pass)                                                                      |

`release:check` on 2026-07-30 also green: format, lint, typecheck, unit + integration + repository + migrations + security + cov + build.

**Warnings (non-failing):** `npm warn Unknown env config "devdir"` on some hosts.

## 2. GitHub Actions / Compose (2026-07-30 → 2026-07-31)

On push to `master`, CI runs:

- `static-and-tests` — mirrors `release:check` against Postgres service
- `compose-and-e2e` — `test:compose`, `test:restart`, `test:e2e:n8n`

Latest successful runs for this beta line:

- Empty-result incident fix: [run 30581191752](https://github.com/werniq/quorum_core/actions/runs/30581191752) (both jobs green)
- Beta demo kit: [run 30604654391](https://github.com/werniq/quorum_core/actions/runs/30604654391) (both jobs green)

## 3. Incident path regression (automated)

| Path                                                                            | Evidence                                                                          |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Healthy → warning → Overdue → recovered (1-minute fixed-rate, no alert channel) | `tests/watcher/incidents-outbox-catalog.test.ts`                                  |
| Silent-absence card copy + n8n / contract actions                               | `tests/ui/silent-absence-incidents.test.ts`                                       |
| Hard failure clears silence; **Failure reported** badge; recovery summary       | `tests/ui/hard-failure-incidents.test.ts`, `tests/ui/catalog-card-polish.test.ts` |
| Empty-result ingest + cadence timestamps + Catalog empty/violation badges       | `tests/ingestion/empty-result-handling.test.ts`, domain empty-result tests        |
| Catalog product UX (health vs evidence vs alerts)                               | `tests/ui/catalog-product-ux.test.ts`                                             |

## 4. Real n8n validation (carry-forward 2026-07-21)

Last full `npm run test:e2e:n8n:real` packet remains authoritative for wall-clock silence. Re-runs write `docs/verification/artifacts/real-n8n-run.json` (gitignored).

| Item              | Value                                                          |
| ----------------- | -------------------------------------------------------------- |
| n8n image         | `n8nio/n8n:1.95.3` (pinned, no fallback)                       |
| Compose           | `docker-compose.e2e.yml` + `docker-compose.e2e.validation.yml` |
| Example workflow  | `examples/n8n/quorum-signed-heartbeat.json`                    |
| Alert destination | Host alert mock webhook (no Slack/SMTP credentials)            |

| Check                                                                     | Result                     |
| ------------------------------------------------------------------------- | -------------------------- |
| ≥2 success heartbeats → catalog Healthy + Basic                           | yes                        |
| Invalid signature / stale timestamp / wrong workflow / revoked credential | 401                        |
| Idempotency replay (n8n-signed)                                           | 1 row; conflict body → 409 |
| Hard failure incident                                                     | opened                     |
| Empty-result allowed / warning / failure policies                         | exercised                  |
| Poll UI + checkpoint                                                      | yes                        |
| Restart Quorum container                                                  | checkpoint unchanged       |

### Silent absence (wall clock, 2026-07-21)

Cadence: 1 minute, `since_last_success`, `allowed_lateness_minutes=0`.

| Event                          | UTC timestamp              |
| ------------------------------ | -------------------------- |
| Last successful heartbeat      | `2026-07-21T10:46:32.235Z` |
| Workflow deactivated           | `2026-07-21T10:46:32.617Z` |
| Expected deadline (~last + 1m) | `2026-07-21T10:47:32.235Z` |
| `silent_absence` opened        | `2026-07-21T10:47:34.665Z` |
| Same incident resolved         | `2026-07-21T10:47:59.710Z` |
| Resolution outbox processed    | `2026-07-21T10:48:04.703Z` |

**Detection latency (last success → incident open):** ~**62.4 s** (~2.4 s after the 60 s deadline).  
**Duplicate incident after open:** none within two watcher cycles.

## 5. Alerts, persistence, KEK

Covered inside CI `compose-and-e2e` / prior real n8n:

- Webhook test + incident + resolution paths
- Failed delivery visibility via channel health
- SQLite + incidents survive process restart
- Wrong KEK restart → heartbeat 401, **no KEK printed**

## 6. Security checks

Still green: JSON API tenant trust (`resolveTrustedTenantId`); metrics disabled by default; HMAC guards; ops audit; `networkPolicy: self_hosted_local`.

## 7. UI review

| Item                                               | Status                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Silence vs hard failure vs empty-result card tones | covered by catalog polish / hard-failure / empty-result tests               |
| Expectation labels                                 | humanized (`Every N minutes`)                                               |
| Waiting / Paused / No recent execution / Overdue   | present                                                                     |
| Evidence vs alert health                           | separate badges                                                             |
| Lifecycle composition                              | `docs/screenshots/lifecycle.png` (Healthy → Missing → Incident → Recovered) |

## 8. Re-running the gate

```bash
git clone https://github.com/werniq/quorum_core.git
cd quorum_core
npm ci
npm run verify:self-hosted
npm run test:e2e:n8n:real
```

Do not weaken or skip tests to make gates pass. Owner soak: [known-limitations.md](../known-limitations.md#owner-soak-24–48-h).
