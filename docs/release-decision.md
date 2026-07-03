# Release decision

**Self-hosted design partners: GO**

Offer self-hosted Quorum for n8n Contract Catalog (push + poll) + alerts when:

- `npm run verify:self-hosted` is green
- `npm run test:e2e:n8n:real` is green (n8n-authored HMAC, wall-clock silent absence, recovery, auth/idempotency, poll UI bind)
- `docs/verification/known-limitations.md` is accepted
- Owner completes `docs/verification/manual-owner-checklist.md` (including 24–48 h soak judgment)

**Hosted SaaS production: NO-GO** (Preview only).

Not general GA for outcome verification of all workflows.

## Gate summary

| Gate                                           | Result                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| AGPL-3.0 public licence                        | Pass                                                        |
| `format:check` + lint / typecheck / build      | Pass (re-run under `verify:self-hosted`)                    |
| Unit tests (`npm run test`)                    | 219 passed (44 files) in this session's baseline            |
| Domain coverage (`test:cov`)                   | ~98.9% statements / lines on gated domain files             |
| Local CI workflow (`.github/workflows/ci.yml`) | Present; YAML validated locally                             |
| Clean Compose black-box                        | Pass                                                        |
| Restart persistence                            | Pass                                                        |
| Real n8n e2e (`test:e2e:n8n`)                  | Pass (n8n Code HMAC via webhook; no host-signed happy path) |
| Real n8n validation (`test:e2e:n8n:real`)      | Pass 2026-07-19; detection latency ~62 s                    |
| HMAC mutation conclusive                       | Pass                                                        |
| Ops audit + waiting state                      | Pass                                                        |
| Polling onboarding (UI bind)                   | Available                                                   |
| Phase B HubSpot→Zoom                           | Preview only                                                |
| Postgres hosted runtime                        | Preview (smoke)                                             |
| Metrics not public by default                  | Pass                                                        |

## Unsupported claims

- End-to-end verification for all n8n workflows (Planned)
- Zapier / Make (Planned)
- Guaranteed delivery / product stops all incidents
- Production SaaS readiness
- Real Slack/SMTP delivery without owner credentials

Machine-readable readiness: `src/release/customer-readiness.ts`.

Verification packet: `docs/verification/`.  
Final real n8n report: `docs/verification/final-real-n8n-validation.md`.  
Remediation baseline: `docs/verification/self-hosted-remediation-report.md`.
