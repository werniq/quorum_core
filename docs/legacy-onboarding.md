# Legacy Protect onboarding

The older **Protect a client** wizard is superseded by **Set up monitoring** (`/onboarding`).

- `GET /protect` redirects to `/onboarding`.
- Existing clients, workflows, contracts, connectors, and channels remain usable.
- `POST /protect/*` handlers remain for verification scripts and bookmarks; the canonical product path is onboarding.

Prefer [getting-started.md](getting-started.md) for first-time setup.
