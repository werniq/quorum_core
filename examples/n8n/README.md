# Quorum n8n examples

## Signed heartbeat workflow

Import `quorum-signed-heartbeat.json` into n8n.

### Fix: `Cannot find module 'crypto'` / `VMError`

n8n Code nodes run in a sandbox. `require('crypto')` is blocked until you allow it.

Set this on the **n8n process** (not only Quorum), then **restart n8n**:

```bash
NODE_FUNCTION_ALLOW_BUILTIN=crypto
```

**Docker Compose example:**

```yaml
services:
  n8n:
    environment:
      NODE_FUNCTION_ALLOW_BUILTIN: crypto
```

Quorum’s e2e compose already sets this in `docker-compose.e2e.yml`.

### Quorum credential env vars

Also set on n8n:

| Variable             | Meaning                                                  |
| -------------------- | -------------------------------------------------------- |
| `QUORUM_WORKFLOW_ID` | Quorum workflow id (from Quorum UI)                      |
| `QUORUM_KEY_ID`      | Push credential key id                                   |
| `QUORUM_HMAC_SECRET` | Push credential secret (shown once)                      |
| `QUORUM_BASE_URL`    | Quorum base URL, e.g. `http://host.docker.internal:3000` |

Do not commit real secrets into the exported JSON.
