# Quorum n8n examples

Pinned for Quorum e2e: **n8n@1.95.3** (`n8nio/n8n:1.95.3`).

## Recommended: signed heartbeat with Crypto nodes

Import [`quorum-signed-heartbeat.json`](./quorum-signed-heartbeat.json).

Flow:

1. **Schedule Trigger** (every 1 minute)
2. **Code** — build `bodyRaw`, timestamp, idempotency key, path, URL (**no** `require` / `import` of Node modules)
3. **Crypto** — Hash SHA256 HEX of `bodyRaw` → `bodySha256Hex`
4. **Code** — compose canonical `signingPayload`
5. **Crypto** — HMAC SHA256 HEX of `signingPayload` → `signature`
6. **HTTP Request** — `POST` with Quorum headers

Canonical signing (must match Quorum `heartbeat-hmac.ts`):

```
signingPayload = ["POST", path, timestampSeconds, idempotencyKey, bodySha256Hex].join("\n")
signature = HMAC-SHA256(secret, signingPayload) as hex
body hash = SHA256(bodyRaw) as hex
```

This path does **not** need `NODE_FUNCTION_ALLOW_BUILTIN`.

### n8n@1.95.3 Crypto credential limitation

On **1.95.3**, `n8n-nodes-base.crypto` is **typeVersion 1**. HMAC uses a **Secret** node parameter (`typeOptions.password`), not dedicated Crypto credentials.

Later n8n versions moved HMAC secrets into Crypto credentials. On this pin:

- Set the HMAC secret with expression `={{ $env.QUORUM_HMAC_SECRET }}` so the exported JSON never embeds a real secret.
- Do not expect a Crypto credentials picker for HMAC on 1.95.3.

Verified from upstream [`Crypto.node.ts` at n8n@1.95.3](https://github.com/n8n-io/n8n/blob/n8n%401.95.3/packages/nodes-base/nodes/Crypto/Crypto.node.ts): Hash/HMAC actions use `secret` as a string parameter; no credentials block on the node.

### Quorum credential env vars

Set on the **n8n process** (not only Quorum):

| Variable | Meaning |
| --- | --- |
| `QUORUM_WORKFLOW_ID` | Quorum workflow id (from Quorum UI) |
| `QUORUM_KEY_ID` | Push credential key id |
| `QUORUM_HMAC_SECRET` | Push credential secret (shown once) |
| `QUORUM_BASE_URL` | Quorum base URL, e.g. `http://host.docker.internal:3000` or `http://quorum:3000` on a shared Docker network |

Do not commit real secrets into exported JSON.

### n8n Cloud notes

- n8n Cloud does not expose `NODE_FUNCTION_ALLOW_BUILTIN`; the **Crypto-node** workflow is the right approach there.
- Whether `$env.QUORUM_*` is available depends on your Cloud plan / env-var support. If env vars are unavailable, set placeholders in Code nodes and map the HMAC secret carefully in the Crypto node UI (avoid exporting that JSON).
- Confirm the Cloud n8n version: if it is newer than 1.95.3, the Crypto node may require Crypto credentials for HMAC instead of the parameter used in this pin.

## Legacy: Code node `require('crypto')`

Optional fallback: [`quorum-signed-heartbeat-legacy-code-crypto.json`](./quorum-signed-heartbeat-legacy-code-crypto.json).

Only needed if you cannot use Crypto nodes. Code nodes sandbox `require('crypto')` until you allow it on the **n8n process**, then **restart n8n**:

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

Quorum’s e2e compose still sets this in `docker-compose.e2e.yml` for harnesses that sign inside Code nodes. Prefer the Crypto-node workflow for new installs.
