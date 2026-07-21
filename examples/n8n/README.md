# Quorum n8n examples

## Supported n8n range

Tested with:

| Bound | Image / version | Notes |
| --- | --- | --- |
| **Minimum** | `n8nio/n8n:1.95.3` | Crypto Hash/HMAC via **typeVersion 1** (`Secret` parameter) |
| **Current stable** | `n8nio/n8n:2.31.4` (or newer patch on the same minor) | Same export works; Crypto **credentials** available from **n8n ≥ 2.7.0** (Crypto typeVersion 2) |

The recommended JSON uses **stable Crypto typeVersion 1** fields so one export runs across that range without version-specific forks.

## Recommended: signed heartbeat with Crypto nodes

Import [`quorum-signed-heartbeat.json`](./quorum-signed-heartbeat.json).

Flow:

1. **Schedule Trigger** (every 1 minute)
2. **Code** — build `bodyRaw`, timestamp, idempotency key, path, URL (**no** `require` / `import` of Node modules); validates required config
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

### Setup (copy-paste)

**In Quorum**

1. Register a workflow with monitoring method **push**.
2. Open the workflow → issue a push credential.
3. Copy:
   - **Workflow ID** (Quorum id in the URL `/workflows/<id>`, not the n8n external id)
   - **Key ID**
   - **Secret** (shown once)

**On the n8n process** (Docker Compose `environment:`, systemd, etc.) — not in the exported JSON:

```bash
QUORUM_WORKFLOW_ID=<quorum-workflow-id>
QUORUM_KEY_ID=<key-id>
QUORUM_HMAC_SECRET=<secret-shown-once>
QUORUM_BASE_URL=http://host.docker.internal:3000   # or http://quorum:3000 on a shared Docker network
```

**n8n 2.x env access:** Code nodes and expressions cannot read `$env` unless you set:

```bash
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Then import the workflow, activate it, and confirm Quorum shows **Healthy** / Basic evidence after the first accepted heartbeat.

If `$env` must stay blocked, edit the `CONFIG` literals in **Prepare Heartbeat** after import (see comments in that node). Prefer Crypto credentials for the HMAC secret on n8n ≥ 2.7 (below).

### HMAC secret: credentials vs env

| Approach | When | How |
| --- | --- | --- |
| **Env + Crypto typeVersion 1** (exported default) | Widest range, including 1.95.3 | HMAC node `Secret` = `={{ $env.QUORUM_HMAC_SECRET }}`. Requires env access (see above). |
| **Crypto credentials** (preferred when available) | **n8n ≥ 2.7.0** | After import: set HMAC Crypto node to **typeVersion 2**, create **Crypto** credentials with **Hmac Secret**, attach them. Set `QUORUM_USE_CRYPTO_CREDENTIAL=1` so Prepare skips the env-secret check. Keep workflow id / key id / base URL via env or `CONFIG` literals. |

Do **not** commit real secrets into exported JSON. The recommended file only references `$env.QUORUM_HMAC_SECRET`.

### Real incompatibilities

- **Crypto credentials for HMAC do not exist before n8n 2.7.0.** On older builds the HMAC secret is a password-style **Secret** parameter on Crypto typeVersion 1. The export targets that portable shape.
- **If you create a new Crypto HMAC node on n8n ≥ 2.7**, the UI defaults to typeVersion 2 and **requires** Crypto credentials (no `Secret` field). Keep the imported typeVersion 1 node, or switch fully to credentials as above.
- **n8n 2.x blocks `$env` by default.** Without `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `$env.QUORUM_HMAC_SECRET` resolves empty/undefined and Crypto typeVersion 1 calls `createHmac` with an undefined key → Node’s raw `key ... Received undefined` error. Prepare Heartbeat now fails earlier with a clear `Missing QUORUM_HMAC_SECRET` message when the env path is intended.
- One JSON **cannot** simultaneously be Crypto v1+`Secret` and Crypto v2+credentials. The export picks v1+env for range; credentials are a documented post-import upgrade on ≥ 2.7.

### n8n Cloud notes

- Cloud does not expose `NODE_FUNCTION_ALLOW_BUILTIN`; use this Crypto-node workflow (not the legacy Code `require('crypto')` path).
- Env-var support and `$env` policy depend on plan/settings. If env vars are unavailable, edit `CONFIG` in Prepare Heartbeat and use Crypto credentials for the secret when the Cloud n8n version is ≥ 2.7.
- Confirm your Cloud n8n version against the table above.

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

Quorum’s e2e compose may still set this for harnesses that sign inside Code nodes. Prefer the Crypto-node workflow for new installs.
