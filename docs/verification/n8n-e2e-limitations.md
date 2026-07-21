# n8n e2e limitations (`npm run test:e2e:n8n`)

Pinned image: `n8nio/n8n:1.95.3` (fallback pull: `n8nio/n8n:1.84.0` for the shorter e2e only).

For the definitive real-container matrix (silent absence wall-clock, empty policies via SQL, poll checkpoint/restart), use `npm run test:e2e:n8n:real` (`scripts/verify-real-n8n-validation.mjs`). That script pins **1.95.3 with no fallback**, requires n8n Code-node HMAC for happy-path pushes, and writes `docs/verification/artifacts/real-n8n-run.json` (gitignored). A snapshot from 2026-07-21 is archived at [docs/archive/2026-07-release-validation/payloads/real-n8n-run.json](../archive/2026-07-release-validation/payloads/real-n8n-run.json). Narrative results: [release-verification.md](./release-verification.md).

## What is real

- Real Quorum container (`docker-compose.e2e.yml` build).
- Real n8n container on the shared compose network.
- Owner setup + API key minting works on 1.95.3 (user management enabled for e2e).
- Push workflow is **created** in real n8n with HMAC Code + HTTP nodes.
- Happy-path push: REST execute if available, otherwise **webhook trigger** (signing stays in n8n Code). **No host-signed happy-path fallback** — if n8n cannot sign/trigger, the script exits 1.
- Invalid signature (401), idempotent replay, hard-failure incidents, and empty-result (`allowed`) are exercised against Quorum (adversarial/control paths may host-sign).
- Self-hosted poll uses `networkPolicy: "self_hosted_local"` in `main.ts` so compose-internal `http://n8n:5678` is allowed (metadata stays blocked). Hosted SaaS still requires public HTTPS.

## Documented gaps (not silently mocked)

| Area                            | Limitation                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| n8n workflow execute            | REST execute paths (`/run`, `/execute`) often 404/401 on this pin. E2E then triggers the production webhook; Code node still signs.            |
| Silent absence                  | Full quiet-window wait (≥1 minute) is not part of the default `test:e2e:n8n` budget — use `test:e2e:n8n:real`.                                 |
| Empty-result **failure** policy | Protect UI hardcodes `emptyResultPolicy: "allowed"`. Shorter e2e asserts allowed; `test:e2e:n8n:real` mutates SQL for warning/failure.         |
| Poll path (workflow bind)       | Shorter e2e has limited bind coverage; `test:e2e:n8n:real` binds via UI (`POST /workflows/:id/connector`), checks checkpoint, restarts Quorum. |
| Two-worker claim exclusivity    | Not practical in single-compose e2e; covered by `tests/security/worker-concurrency.test.ts` / poll-scheduler unit tests.                       |

When a pinned-version API action cannot be completed, the shorter e2e prints `[limitation] ...` on stderr. It does **not** mock n8n or Quorum responses, and it does **not** host-sign the happy-path success push.
