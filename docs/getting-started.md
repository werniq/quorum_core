# Getting started

After [Quick start](../README.md#quick-start-docker), use this page for first-run details.

## First-time setup

1. Copy `.env.example` to `.env` and set secrets ([environment](environment.md)).
2. Pull and start the published image:

   ```bash
   docker pull qniw984/quorum:0.1.0-beta.3
   docker compose up -d
   ```

3. Open http://127.0.0.1:3000/setup and create the local administrator (when UI auth is on).
4. Open **Set up monitoring** (`/onboarding`).
5. Create or select a client, connect n8n, select workflows, confirm expectations, test alerts, **Start monitoring**.

You should not need Quorum workflow IDs, connector IDs, contract IDs, or HMAC secrets for the normal polling path.

To build from this repository instead of pulling:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build -d
```

### Auth

- **Auth on (default):** set `QUORUM_SETUP_TOKEN` (≥24 characters), visit `/setup`, create the admin. The admin password is not the setup token; it must be ≥12 characters and must not match known defaults such as `password`, `changeme`, or `quorum123`.
- **Open UI:** `QUORUM_UI_AUTH_ENABLED=false`, or `QUORUM_DEMO_MODE=true` only on a localhost bind (`HOST` is `127.0.0.1` / `localhost` / `::1`). Demo mode is rejected with `HOST=0.0.0.0`.

## Local lab (Quorum + n8n)

For onboarding against a real n8n container:

```bash
docker compose -f docker-compose.lab.yml up --build
```

| Service | In the browser        | From Quorum onboarding |
| ------- | --------------------- | ---------------------- |
| Quorum  | http://127.0.0.1:3000 | —                      |
| n8n     | http://127.0.0.1:5678 | `http://n8n:5678`      |

1. Open n8n, create the owner account, then **Settings → n8n API** → create an API key.
2. In Quorum onboarding, connect with URL `http://n8n:5678` and that API key (`localhost` will not work from inside the Quorum container).

Lab defaults disable UI auth and use throwaway secrets. Tear down with `docker compose -f docker-compose.lab.yml down` (add `-v` to wipe volumes).

## Canonical UI vs advanced pages

- **Set up monitoring** (`/onboarding`) is the first-run flow.
- `/protect` redirects to `/onboarding` ([legacy notes](legacy-onboarding.md)).
- **Connectors**, **Workflows**, and **Alert channels** remain for advanced management.

Workflow discovery and cadence inference: [onboarding-discovery.md](onboarding-discovery.md). Connect n8n (polling and push): [connect-n8n.md](connect-n8n.md).
