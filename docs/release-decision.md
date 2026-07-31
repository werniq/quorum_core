# Release decision

**Self-hosted Community (design partners): CONDITIONAL GO**

Offer self-hosted Quorum for n8n Contract Catalog (push + poll) + alerts when:

- `npm run verify:self-hosted` is green (or equivalent CI `static-and-tests` + `compose-and-e2e`)
- `npm run test:e2e:n8n:real` remains green for wall-clock silent absence (last full packet 2026-07-21; short e2e covered on every master push)
- [docs/known-limitations.md](./known-limitations.md) is accepted
- Owner completes a 24–48 h soak judgment (`scripts/start-soak-test.sh` / `scripts/check-soak-test.sh`; see known-limitations)

Latest verification packet: [docs/verification/release-verification.md](./verification/release-verification.md) (2026-07-31).

**Hosted SaaS production: NO-GO.** Billing and hosted runtime code are not part of the Community Apache-2.0 tree.

Not general GA for outcome verification of all workflows.

## Gate summary

| Gate                                             | Result (2026-07-31)                                                                                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache-2.0 public licence                        | Pass                                                                                                                                                                         |
| Package / image                                  | `quorum@0.1.0-beta.5` / `qniw984/quorum:0.1.0-beta.5`                                                                                                                        |
| `format:check` + lint / typecheck / build        | Pass (`release:check` 2026-07-30; format/lint 2026-07-31)                                                                                                                    |
| Unit suite (`npm test`)                          | **322 passed**, 0 skipped (55 files) on 2026-07-31                                                                                                                           |
| Domain coverage (`test:cov`)                     | **93.34%** stmts/lines; **91.57%** branches; 100% funcs (gated domain; ≥90% gate)                                                                                            |
| GitHub Actions CI (`.github/workflows/ci.yml`)   | Pass on master — [empty-result](https://github.com/werniq/quorum_core/actions/runs/30581191752) + [beta kit](https://github.com/werniq/quorum_core/actions/runs/30604654391) |
| Clean Compose black-box (`test:compose`)         | Pass (CI `compose-and-e2e`)                                                                                                                                                  |
| Restart persistence + wrong KEK                  | Pass (CI `compose-and-e2e`)                                                                                                                                                  |
| Real n8n e2e (`test:e2e:n8n`)                    | Pass (CI `compose-and-e2e`)                                                                                                                                                  |
| Real n8n validation (`test:e2e:n8n:real`)        | Pass (2026-07-21 packet); silent-absence latency ~62 s                                                                                                                       |
| Silent absence UI + recovery (no alert channel)  | Pass (`tests/watcher/incidents-outbox-catalog.test.ts`, catalog/incident UI tests)                                                                                           |
| Hard failure vs silence separation               | Pass (ingest + catalog **Failure reported** path)                                                                                                                            |
| Empty-result as cadence evidence (no silence UX) | Pass (ingest + domain + catalog UI tests; shipped 2026-07-30)                                                                                                                |
| HMAC mutation conclusive                         | Pass                                                                                                                                                                         |
| Polling onboarding (UI bind)                     | Pass in real-n8n script / short e2e                                                                                                                                          |
| Phase B HubSpot→Zoom                             | Preview only                                                                                                                                                                 |
| Hosted SaaS / Postgres product runtime           | Not in Community tree                                                                                                                                                        |
| Metrics not public by default                    | Pass                                                                                                                                                                         |
| Owner 24–48 h soak                               | **Still required** before calling design-partner install ready                                                                                                               |

## Unsupported claims

- General outcome verification across the entire n8n estate (Planned)
- Zapier / Make (Planned)
- Guaranteed delivery / product stops all incidents
- Production SaaS readiness or checkout
- Real Slack/SMTP delivery without owner credentials
- Unconditional GA without owner soak

Machine-readable readiness: `src/release/customer-readiness.ts`.

Verification packet: [docs/verification/release-verification.md](./verification/release-verification.md).  
Re-runs of real n8n validation write `docs/verification/artifacts/real-n8n-run.json` (gitignored).
