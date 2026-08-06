# Incident API (read)

Tenant-scoped, read-only JSON endpoints. The local tenant is resolved server-side (foreign `x-quorum-tenant-id` values are rejected). Responses use camelCase incident records and never include webhook/SMTP delivery attempts or outbox rows.

Webhooks **push** incident change notifications. They are not a pull API for current state — use these endpoints for authoritative incident records.

## List incidents

```http
GET /api/v1/incidents
```

| Query          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| `status`       | One or more of `open`, `acknowledged`, `resolved` (comma-separated)           |
| `severity`     | `warning` or `critical`                                                       |
| `workflowId`   | Exact workflow id                                                             |
| `contractId`   | Matches `workflowId` or `outcomeContractId`                                   |
| `clientId`     | Exact client id                                                               |
| `updatedAfter` | ISO-8601; only incidents with `updatedAt` strictly after this value           |
| `limit`        | Page size (default `50`, max `100`)                                           |
| `cursor`       | Opaque cursor from a previous `nextCursor` (keyset on `updatedAt`, then `id`) |

Ordering: `updatedAt DESC`, then `id DESC`. Invalid filters return `400` with `{ "error": "…" }`.

```bash
curl "http://localhost:3000/api/v1/incidents?status=open,acknowledged&limit=50"
```

```json
{
  "items": [
    {
      "id": "…",
      "tenantId": "…",
      "status": "open",
      "severity": "critical",
      "summary": "…",
      "updatedAt": "…"
    }
  ],
  "nextCursor": null
}
```

## Get one incident

```http
GET /api/v1/incidents/:incidentId
```

Returns `{ "incident": { … } }` for incidents visible to the local tenant. Missing or other-tenant ids return `404` `{ "error": "not_found" }`.

```bash
curl "http://localhost:3000/api/v1/incidents/<incidentId>"
```

## Acknowledge and resolve

Acknowledgement and recovery are separate dimensions:

| Action                         | Endpoint                                         | Effect                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acknowledge / mark reviewed    | `POST /api/v1/incidents/:incidentId/acknowledge` | Sets `acknowledgmentStatus=acknowledged` with actor/timestamp/optional note. Does **not** recover the incident. Active incidents stay `lifecycleStatus=active` and unhealthy. Recovered + unacknowledged incidents can use the same endpoint as post-recovery review. Idempotent. |
| Resolve (operational recovery) | `POST /api/v1/incidents/:incidentId/resolve`     | Sets `lifecycleStatus=recovered` and recovery timestamps/evidence. Preserves any existing acknowledgement metadata. Automatic recovery from healthy evidence uses the same repository path.                                                                                       |

```bash
curl -X POST "http://localhost:3000/api/v1/incidents/<incidentId>/acknowledge" \
  -H "content-type: application/json" \
  -d '{"note":"Investigating with ops"}'
```
