# README review — 2026-07-21 (public GitHub rewrite)

## Goal

Public GitHub README: natural developer voice, screenshots before setup, honest beta limits, no marketing filler.

## Structure

1. Problem, audience, detections
2. Contract Catalog screenshot
3. How it works (contracts, push, poll, incidents, alerts, recovery)
4. Contract detail, incidents, onboarding screenshots
5. Beta status, Docker quick start, n8n connection
6. Alerts, security, backup/upgrades, health endpoints, development
7. Limitations (heartbeats do not prove delivery; hosted SaaS unavailable)

Implementation-agent and release-gate detail moved to [docs/specification/README.md](../specification/README.md).

## Command and path verification

| README reference | Verified |
| ---------------- | -------- |
| `cp .env.example .env` | `.env.example` exists |
| `docker compose up --build -d` | `docker-compose.yml` exists; port `${QUORUM_HOST_PORT:-3000}:3000` |
| `http://127.0.0.1:3000/` | matches `PUBLIC_BASE_URL` default |
| `/setup`, `/catalog`, `/network-privacy` | routes in `src/infrastructure/http/routes/ui.ts` |
| `QUORUM_CREDENTIAL_KEK`, `QUORUM_SETUP_TOKEN`, `QUORUM_HOST_PORT` | in `.env.example` / compose |
| `NODE_FUNCTION_ALLOW_BUILTIN=crypto` | documented in `examples/n8n/README.md` |
| n8n env vars pointer | `examples/n8n/README.md` |
| `npm ci`, `typecheck`, `test`, `build`, `dev`, `verify:self-hosted` | in `package.json` |
| `npm run security:deps` | in `package.json` |
| Health endpoints | documented in `docs/operations.md` |
| Screenshots | `docs/screenshots/*.png` generated from `docs/verification/ui-preview/*.html` via `scripts/capture-readme-screenshots.mjs` |
| Linked docs | exist under `docs/` |

## Intentional omissions from root README

- Stripe / hosted SaaS setup
- `test:e2e:n8n:real` (in specification README)
- Full env var table (see `.env.example` and `docs/operations.md`)
- WorkflowGuard (none in tree)

## Regenerate screenshots

```bash
npx tsx scripts/generate-ui-previews.mjs
node scripts/capture-readme-screenshots.mjs
```

Requires `playwright` dev dependency.
