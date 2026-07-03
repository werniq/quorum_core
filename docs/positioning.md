# Quorum positioning and claims

## Brand promise

> Define what each critical workflow should do. Quorum checks whether it ran, whether its reported volume stayed within the expected range, and how strong the evidence actually is.

## Volume differentiator

> A workflow can run successfully and still process too little or too much. Quorum checks the reported number as well as the execution status.

## Self-hosted identity

> Open source, zero telemetry, and designed so your workflow data can stay in your infrastructure.

## Agency value

> Reliability evidence that protects client retainers and supports proactive maintenance reporting.

## Heartbeat monitoring context (internal strategy)

Basic heartbeat monitoring is competitively priced and available through free or inexpensive tiers. Quorum competes on workflow contracts, business-volume checks, evidence transparency, incident response, self-hosting, and supported reconciliation paths. Do not put competitor pricing in runtime product copy.

## Phase A — heartbeat + volume foundation (Available)

**Allowed claim**

> Quorum shows what your n8n workflows are expected to do, whether reported volume stayed inside declared bands, and alerts you when they fail, stop reporting, or produce an unacceptable result.

**Required limitation**

> Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.

Volume-band checks based on heartbeat-reported `items_processed` remain Basic evidence. Medium or High still requires independent destination aggregate or record-level reconciliation.

## Phase B — first outcome path (Preview)

**Supported path:** HubSpot webinar registrations → Zoom webinar registrants.

**Allowed claim for that path**

> Quorum independently verifies supported business outcomes and identifies records that failed to reach their destination.

Do not generalize to every n8n workflow.

## Feature availability labels

- **Available** — in the default runtime, usable path, production-like deploy, passing black-box or automated tests
- **Preview** — works end to end with documented limits; not general production approval
- **Planned** — design or partial code exists; normal runtime cannot use it fully

## Prohibited before broad reconciliation

Do not publish unqualified guarantees such as:

- guaranteeing that every lead arrives at the destination
- claiming end-to-end verification across the entire n8n estate
- advertising complete reliability of every workflow
- asserting that silent failures are impossible
- saying the product prevents incidents from occurring
- describing Quorum primarily as a heartbeat monitor
- claiming volume bands independently verify destination delivery

Machine-readable source: `src/product/positioning.ts`.
