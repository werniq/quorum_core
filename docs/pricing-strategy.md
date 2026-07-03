# Pricing strategy (internal)

Target prices are positioning defaults. Change here or via env without schema migrations.

## Self-hosted Quorum Community

- Free under AGPL-3.0
- No licence-enforced active workflow limit
- Heartbeat, cadence, empty-result, and volume-band monitoring included
- Single-tenant operation
- Local alerts and catalog
- Operational scale still depends on host hardware and ops practices

## Quorum Cloud (Planned while hosted SaaS is NO-GO)

Fixed plan entitlements only. No per-heartbeat, execution, or API metering.

| Plan       | Target EUR/month | Active clients | Active contracts | Users  | History | Highlights                                                                               |
| ---------- | ---------------- | -------------- | ---------------- | ------ | ------- | ---------------------------------------------------------------------------------------- |
| Consultant | 49               | 3              | 30               | 1      | 90 days | Incident triage, response targets, standard reports                                      |
| Agency     | 149              | 10             | 100              | 5      | 1 year  | White-label reports, client response targets, priority alert routing                     |
| Agency Pro | 349              | 30             | 300              | 15     | 2 years | Reconciliation contracts, missing-record exports, custom report domain, priority support |
| Enterprise | custom           | custom         | custom           | custom | custom  | Sales-led                                                                                |

Implementation: `src/domain/billing/plans.ts` (`PLAN_TARGET_PRICES_EUR`, `DEFAULT_PLAN_LIMIT_CONFIG`).

Marketing should lead with clients protected, response workflow, reports, team features, evidence retention, and reconciliation. Active-contract limits are fair-use packaging boundaries.

## Competitor context (internal only)

Basic heartbeat monitoring is competitively priced through free or inexpensive tiers. Do not claim Watchflow or others are "simply free" in product copy. Quorum competes on workflow contracts, volume bands, evidence transparency, incident response, self-hosting, and supported reconciliation paths.

Do not embed competitor pricing in runtime UI.
