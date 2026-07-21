# Release decision

**Self-hosted Community (design partners): CONDITIONAL GO**

Offer self-hosted Quorum for n8n Contract Catalog (push + poll) + alerts when:

- `npm run verify:self-hosted` is green
- `npm run test:e2e:n8n:real` is green (n8n-authored HMAC, wall-clock silent absence, recovery, auth/idempotency, poll UI bind)
- `docs/verification/known-limitations.md` is accepted
- Owner completes `docs/verification/manual-owner-checklist.md` (including 24–48 h soak judgment)

Latest verification packet: [docs/verification/final-release-verification.md](./verification/final-release-verification.md) (2026-07-21).

**Hosted SaaS production: NO-GO.** Billing and hosted runtime code are not part of the Community AGPL tree.

Not general GA for outcome verification of all workflows.

## Gate summary

| Gate                                             | Result (2026-07-21)                             |
| ------------------------------------------------ | ----------------------------------------------- |
| AGPL-3.0 public licence                          | Pass                                            |
| `format:check` + lint / typecheck / build        | Pass                                            |
| Unit + integration suites (`verify:self-hosted`) | 246 + staged suites; 0 skipped                  |
| Domain coverage (`test:cov`)                     | ~98.9% statements / lines on gated domain files |
| Local CI workflow (`.github/workflows/ci.yml`)   | Present; remote run not claimed this session    |
| Clean Compose black-box                          | Pass                                            |
| Restart persistence + wrong KEK                  | Pass                                            |
| Real n8n e2e (`test:e2e:n8n`)                    | Pass                                            |
| Real n8n validation (`test:e2e:n8n:real`)        | Pass; silent-absence latency ~62 s              |
| HMAC mutation conclusive                         | Pass                                            |
| Ops audit + waiting state                        | Pass                                            |
| Polling onboarding (UI bind)                     | Pass in real-n8n script                         |
| Phase B HubSpot→Zoom                             | Preview only                                    |
| Hosted SaaS / Postgres product runtime           | Not in Community tree                           |
| Metrics not public by default                    | Pass                                            |

## Unsupported claims

- End-to-end verification for all n8n workflows (Planned)
- Zapier / Make (Planned)
- Guaranteed delivery / product stops all incidents
- Production SaaS readiness or checkout
- Real Slack/SMTP delivery without owner credentials

Machine-readable readiness: `src/release/customer-readiness.ts`.

Verification packet: `docs/verification/`.  
Final real n8n report: `docs/verification/final-real-n8n-validation.md` (update from `payloads/real-n8n-run.json` when re-run).
