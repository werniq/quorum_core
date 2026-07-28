# Contributing

Thanks for helping with Quorum Community.

## Before you start

- Read [README.md](README.md) and [docs/known-limitations.md](docs/known-limitations.md)
- Quorum Community is Apache-2.0; do not add proprietary or copyleft-incompatible dependencies without discussion
- Hosted SaaS / billing code is **out of scope** for this repository

## Development

```bash
cp .env.example .env
# set QUORUM_CREDENTIAL_KEK and (for auth) QUORUM_SETUP_TOKEN
npm ci
npm run dev
```

Useful checks:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run verify:self-hosted
```

Docker (build from this repo):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

Published image path: see [README.md](README.md#quick-start-docker).

## Pull requests

- Keep changes focused; prefer small commits with clear intent
- Do not commit `.env`, databases, logs, or real credentials
- Update docs when behaviour or setup steps change
- Add or adjust tests for behaviour changes

## Security

See [SECURITY.md](SECURITY.md). Never commit secrets—even in tests use obvious placeholders.
