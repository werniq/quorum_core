# Design-partner validation plan

## Goal

Validate Quorum with a small set of agency design partners before broader GA, using measurable readiness criteria (not vanity ping metrics).

## Partner profile

- Runs client retainers on **n8n**
- Needs proactive proof that critical processes still work
- Willing to use **self-hosted** Quorum or hosted Preview with explicit evidence limits
- Can configure at least one alert channel and an external check on `/health/watcher`

## Validation scenarios (must pass with partner data)

1. **Protect a client** — create client → critical process → push or public poll → explicit contract → evidence review → alert test → activate → initial client report (before any incident).
2. **Heartbeat honesty** — catalog shows Basic evidence and destination unverified when no reconciliation path is attached.
3. **Silent absence** — stop heartbeats; one incident; catalog deep-link from alert; no duplicate unresolved incidents under concurrent watchers.
4. **Alert path failure** — break webhook; channel becomes degraded/failing; banner appears; Send test clears after recovery; incident truth unchanged.
5. **Preview outcome path** (optional if partner has HubSpot+Zoom) — green n8n with missing Zoom registrant shows missing counts and High only on clean match windows.
6. **Isolation** — second tenant/client cannot see partner A data (hosted) or confirm single-tenant self-hosted boundary.
7. **Backup drill** — partner (or Quorum ops) restores SQLite/Postgres backup + KEK and confirms decrypt + `/readyz`.

## Success metrics (early customers)

| Metric                                        | Target                                    |
| --------------------------------------------- | ----------------------------------------- |
| Time to first protected contract              | &lt; 1 working day with guided onboarding |
| False “fully protected” language in UI        | 0 occurrences                             |
| Undeclared egress / telemetry                 | 0                                         |
| Cross-tenant leakage in adversarial tests     | 0                                         |
| Partner NPS on evidence honesty (qualitative) | “clear what is/ isn’t verified”           |

## Exit criteria for early agency offer

All items in `src/domain/release/early-customer-readiness.ts` are `met` (no `blocker`). See [release-decision.md](./release-decision.md).

## Explicit non-goals for design partners

- Do not sell “verification for all workflows”
- Do not promise incident prevention
- Do not hide that HubSpot→Zoom is **Preview**
