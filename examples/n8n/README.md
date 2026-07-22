# Quorum n8n examples

## Supported n8n range

Tested with:

| Bound | Image / version | Notes |
| --- | --- | --- |
| **Minimum** | `n8nio/n8n:1.95.3` | Crypto Hash/HMAC via **typeVersion 1** (`Secret` parameter filled in the n8n UI after import). CLI `import:workflow` of this export succeeded (2026-07-22). |
| **Current stable** | `n8nio/n8n:2.31.4` (or newer patch on the same minor) | Same export works; Crypto **credentials** available from **n8n ≥ 2.7.0** (Crypto typeVersion 2). CLI `import:workflow` succeeded (2026-07-22). |

Full live signed-heartbeat round-trip against a running Quorum was not re-run in this onboarding change; import smoke + unit tests cover the export and API error shape.

The recommended JSON uses **stable Crypto typeVersion 1** fields so one export runs across that range without version-specific forks. Prefer Crypto credentials on ≥ 2.7 after import (documented below); the export is not tied to typeVersion 2.

## Choose a path (in order)

1. **Polling (easiest)** — Quorum URL + n8n API key in Quorum Connectors. No workflow changes, no n8n env vars, no restart.
2. **Push with Crypto nodes** — More detailed reporting. Edit one setup node in the n8n UI; store the HMAC secret in a Crypto credential when supported.
3. **Environment variables (advanced)** — Docker/K8s process env for fleets that inject secrets centrally.

---

## 1. Polling (easiest)

In Quorum:

1. Add an n8n connector (**Connectors**): base URL + API key.
2. Register the workflow with monitoring method **Connect n8n** (or select that registration in Protect).
3. Bind the connector, define the contract, **activate**.

No import of this example workflow is required.

---

## 2. Push with Crypto nodes (normal push path)

Import [`quorum-signed-heartbeat.json`](./quorum-signed-heartbeat.json).

Flow:

1. **Schedule Trigger** (every 1 minute)
2. **Quorum Setup (edit me)** — CONFIG literals for Quorum base URL, **Quorum workflow ID**, and **Key ID** (customer edits in the n8n UI)
3. **Crypto** — Hash SHA256 HEX of `bodyRaw` → `bodySha256Hex`
4. **Code** — compose canonical `signingPayload`
5. **Crypto** — HMAC SHA256 HEX of `signingPayload` → `signature` (secret in UI / Crypto credential)
6. **HTTP Request** — `POST` with Quorum headers

Canonical signing (must match Quorum `heartbeat-hmac.ts`):

```
signingPayload = ["POST", path, timestampSeconds, idempotencyKey, bodySha256Hex].join("\n")
signature = HMAC-SHA256(secret, signingPayload) as hex
body hash = SHA256(bodyRaw) as hex
```

This path does **not** need `NODE_FUNCTION_ALLOW_BUILTIN` and does **not** need container environment variables.

### ID glossary (do not mix these up)

| Name | Where it comes from | Used for |
| --- | --- | --- |
| **n8n workflow ID** | n8n URL: `…/workflow/{id}` | Quorum registration field only |
| **Quorum workflow ID** | Quorum Workflows / Protect / credential page | Setup node `quorumWorkflowId` / advanced `QUORUM_WORKFLOW_ID` |
| **Key ID** | Quorum “Issue push credential” | Setup node `keyId` / advanced `QUORUM_KEY_ID` |
| **HMAC secret** | Shown once with the credential | Crypto credential or Crypto HMAC Secret field / advanced `QUORUM_HMAC_SECRET` |

### Setup (copy-paste) — UI only

**In Quorum**

1. Register a workflow with monitoring method **Push heartbeats**.
2. Issue a push credential; copy **Quorum workflow ID**, **Key ID**, and **HMAC secret** (secret shown once).
3. Define the contract and **activate**. Until then, heartbeats return HTTP **409** with `CONTRACT_NOT_ACTIVE` (unknown Quorum workflow id still returns `NOT_FOUND`).

**In n8n (no restart)**

1. Import [`quorum-signed-heartbeat.json`](./quorum-signed-heartbeat.json).
2. Open **Quorum Setup (edit me)** and set:
   - `quorumBaseUrl` — Quorum URL (e.g. `http://host.docker.internal:3000`)
   - `quorumWorkflowId` — **Quorum** workflow ID (not the n8n URL id)
   - `keyId` — Key ID
3. **HMAC secret**
   - **Portable (exported default):** open **HMAC SHA256 Signature**, replace `REPLACE_HMAC_SECRET_IN_N8N_UI` in the **Secret** field with the real secret (Crypto typeVersion 1).
   - **Preferred on n8n ≥ 2.7.0:** create **Crypto** credentials with **Hmac Secret**, set the HMAC node to **typeVersion 2**, attach the credentials (remove reliance on the typeVersion 1 Secret parameter).
4. Activate the workflow. Expect Quorum **HTTP 202** `{ "status": "accepted", ... }`.

Do **not** commit real secrets into exported JSON.

### Real incompatibilities

- **Crypto credentials for HMAC do not exist before n8n 2.7.0.** On older builds use the Crypto typeVersion 1 **Secret** parameter (filled in the UI after import).
- **If you create a new Crypto HMAC node on n8n ≥ 2.7**, the UI defaults to typeVersion 2 and **requires** Crypto credentials (no `Secret` field). Keep the imported typeVersion 1 node, or switch fully to credentials as above.
- One JSON **cannot** simultaneously be Crypto v1+`Secret` and Crypto v2+credentials. The export picks v1+UI Secret for range; credentials are a documented post-import upgrade on ≥ 2.7.
- Leaving `REPLACE_*` placeholders in the setup node fails with a clear error before signing.

### n8n Cloud notes

- Cloud does not expose `NODE_FUNCTION_ALLOW_BUILTIN`; use this Crypto-node workflow (not the legacy Code `require('crypto')` path).
- Prefer setup-node literals + Crypto credentials when the Cloud n8n version is ≥ 2.7.
- Confirm your Cloud n8n version against the table above.

---

## 3. Environment variables (advanced)

For Docker Compose / Kubernetes secret injection (not the normal customer path). On the **n8n process**:

```bash
QUORUM_WORKFLOW_ID=<quorum-workflow-id>
QUORUM_KEY_ID=<key-id>
QUORUM_HMAC_SECRET=<secret-shown-once>
QUORUM_BASE_URL=http://host.docker.internal:3000
```

On **n8n 2.x**, Code/Crypto `$env` access often also needs:

```bash
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

Then either uncomment the `$env` overrides in **Quorum Setup (edit me)**, or set the Crypto HMAC Secret to `={{ $env.QUORUM_HMAC_SECRET }}`.

---

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

Quorum’s e2e compose may still set this for harnesses that sign inside Code nodes. Prefer polling or the Crypto-node workflow for new installs.
