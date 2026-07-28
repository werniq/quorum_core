# Environment variables

Copy `.env.example` to `.env` before `docker compose up`.

| Variable                 | Required                     | Notes                                                                                                                                                                                                |
| ------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUORUM_CREDENTIAL_KEK`  | Yes                          | Long random secret (min 16 characters). Encrypts push credentials and similar secrets. **Back it up separately from the database** — without it you cannot decrypt stored credentials after restore. |
| `QUORUM_SETUP_TOKEN`     | When UI auth is on (default) | One-time bootstrap token (min 24 characters). Used only at `/setup`. **Not** the admin password.                                                                                                     |
| `QUORUM_UI_AUTH_ENABLED` | Defaults to `true`           | Setup token + login. Set `false` for a local open UI without login.                                                                                                                                  |
| `QUORUM_DEMO_MODE`       | Optional                     | `true` opens the UI without login, but only when `HOST` is localhost (`127.0.0.1` / `localhost` / `::1`). Rejected with `0.0.0.0` — do not enable it in the default Docker compose bind.             |
| `PUBLIC_BASE_URL`        | Recommended                  | e.g. `http://127.0.0.1:3000`.                                                                                                                                                                        |
| `QUORUM_HOST_PORT`       | Optional                     | Host port if `3000` is already taken.                                                                                                                                                                |

Optional worker and poll intervals are commented in `.env.example` (`OUTBOX_INTERVAL_MS`, `N8N_POLL_*`, `HEARTBEAT_TIMESTAMP_TOLERANCE_SECONDS`, metrics flags).

Operations and backup: [operations.md](operations.md).
