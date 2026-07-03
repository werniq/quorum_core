# Known limitations

Updated 2026-07-20 after volume-band, triage, and pricing positioning work.

## Product scope

1. Heartbeat evidence proves a signed execution report arrived. It does not prove destination delivery.
2. Volume-band checks use heartbeat-reported `items_processed` only. They remain Basic evidence and do not prove destination correctness or independent delivery.
3. HubSpot → Zoom is the only named outcome path, and it remains Preview.
4. Zapier and Make are Planned only.
5. Public copy must not claim end-to-end verification of all n8n workflows.
6. Volume rules are created in the data model and evaluated by the watcher. There is no Protect-wizard step for volume rules yet.
7. Incident triage fields exist in the database and repositories. Full triage UI and SaaS API routes are not complete.
8. Quorum Cloud plan entitlements are configured in code. Checkout and hosted SaaS remain NO-GO.

## Runtime and ops

5. CI workflow exists at `.github/workflows/ci.yml`. This pass did not claim a GitHub Actions run; validate on the published remote.
6. `npm run format:check` exists and is part of `release:check` / `verify:self-hosted`.
7. Clean Compose and restart scripts pass locally when Docker is available.
8. Shorter e2e (`npm run test:e2e:n8n`) uses pinned `n8nio/n8n:1.95.3`. REST execute often unavailable; production webhook trigger is used. Happy-path signing stays in n8n Code (no host-signed fallback).
9. Full quiet-window silent absence, empty-result warning/failure policies, poll bind/restart, and resolution outbox checks are in `npm run test:e2e:n8n:real`.
10. Graceful shutdown drains in-flight work up to `SHUTDOWN_GRACE_MS` (default 10s), then may force exit.
11. n8n `/healthz` can succeed while migrations still run; verification scripts wait for `/rest/settings` JSON before owner setup.

## Data model

12. Reconciliation `waiting` is a first-class DB status (migration `0014`). Historical `ignored` rows that meant in-delay waiting were converted to `waiting`.

## Security posture notes

13. Self-hosted JSON APIs are local-tenant oriented after `resolveTrustedTenantId`.
14. HMAC mutation checks are conclusive via `tests/security/heartbeat-hmac-guards.test.ts`.
15. Metrics stay disabled unless explicitly enabled with token or loopback controls.
16. Self-hosted n8n poll may use HTTP on LAN (`networkPolicy: self_hosted_local`). Hosted SaaS still requires public HTTPS. Cloud metadata stays blocked.

## Alerts

17. Automated validation uses a local webhook mock. Real Slack or SMTP delivery is an owner manual check when credentials exist.
18. Outbox `resolved` rows may process with zero `notification_attempts` rows depending on channel path; validation accepts processed `resolved` outbox evidence.

## Hosted / SaaS

19. Postgres `main-saas` is smoke/Preview. Full catalog UI, watcher, outbox, and poll on Postgres are incomplete.
20. Stripe / entitlements remain Preview.
21. Hosted production GA is blocked until Postgres runtime parity and hardened ops exist.

## Design-partner framing

Self-hosted Contract Catalog + n8n heartbeat push/poll + alerts: **GO** for design partners when `npm run verify:self-hosted` is green, `npm run test:e2e:n8n:real` is green, and these limitations are accepted. Hosted SaaS is not cleared for production. A 24–48 hour soak remains an owner gate (`docs/verification/manual-soak-test.md`).
