# Security results

Updated after self-hosted remediation.

## Fixed earlier (still green)

- JSON API tenant trust via `resolveTrustedTenantId`
- SaaS session → membership (no body `actorUserId` authz)
- Metrics disabled by default

## Fixed this pass

### Ops audit coverage

- Table `ops_audit_events` with immutable triggers
- Wired for setup, credentials, contracts, alerts, connectors
- Heartbeat auto-resolve uses `resolveIncident` (incident audit)
- Matrix: `docs/verification/audit-coverage-matrix.md`
- Tests: `tests/security/ops-audit-coverage.test.ts`

### HMAC mutation conclusive

| Mutation                                        | Result                                         |
| ----------------------------------------------- | ---------------------------------------------- |
| Force `verifyHeartbeatSignature` to always true | Required suites **fail** (exit 1)              |
| Restore                                         | Suites **pass**                                |
| Guards                                          | `tests/security/heartbeat-hmac-guards.test.ts` |

### Self-hosted local network poll policy

- `networkPolicy: "self_hosted_local"` allows private HTTP for n8n on self-hosted
- Hosted public HTTPS policy unchanged
- Cloud metadata still blocked
- Tests in `tests/domain/connector-network-security.test.ts`

## Remaining security notes

- Self-hosted JSON APIs are single-tenant oriented
- Hosted SaaS remains Preview / NO-GO
- n8n e2e execute-API limitation documented (not a Quorum auth bypass)
