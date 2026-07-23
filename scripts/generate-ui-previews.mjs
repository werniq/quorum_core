import fs from "node:fs";
import path from "node:path";
import {
  renderOnboardingPage,
  renderWorkflowsPage,
  renderAlertsPage,
} from "../src/presentation/html/pages.ts";
import {
  renderCatalogPage,
  renderProtectClientPage,
  renderSimpleNavPage,
  renderWorkflowContractDetailPage,
} from "../src/presentation/html/catalog-ui.ts";

const dir = path.join("docs", "verification", "ui-preview");
fs.mkdirSync(dir, { recursive: true });

const clients = [
  { id: "c-nw", name: "Northwind Retail" },
  { id: "c-acme", name: "Acme Agency" },
  { id: "c-summit", name: "Summit Finance" },
  { id: "c-lake", name: "Lakeview Health" },
  { id: "c-bright", name: "Brightline Logistics" },
  { id: "c-harbor", name: "Harbor Mutual" },
];

/** @param {Partial<import("../src/presentation/html/catalog-ui.ts").CatalogRowView> & Pick<import("../src/presentation/html/catalog-ui.ts").CatalogRowView, "contractId" | "businessPurposeName">} row */
function contract(row) {
  return {
    workflowId: row.workflowId ?? row.contractId,
    clientId: row.clientId ?? "c-acme",
    clientName:
      clients.find((c) => c.id === (row.clientId ?? "c-acme"))?.name ??
      "Acme Agency",
    health: "healthy",
    evidenceLevel: "basic",
    evidenceExplanation: "Basic — destination not independently checked",
    expectedCadenceOrWindow: "interval:15@UTC",
    lastAcceptableEvidenceAt: "12 minutes ago",
    nextDeadlineAt: "in 3 minutes",
    overdueDurationSeconds: null,
    alertChannelHealth: "healthy",
    connectorHealth: null,
    activeIncident: null,
    contractKind: "workflow",
    sourceCount: null,
    destinationCount: null,
    missingCount: null,
    oldestMissingAgeSeconds: null,
    evidenceStale: false,
    isActive: true,
    verifiedDimensions: [],
    unverifiedDimensions: [],
    volumeSummary: null,
    ...row,
  };
}

const catalogContracts = [
  contract({
    contractId: "w-leads",
    workflowId: "w-leads",
    clientId: "c-acme",
    businessPurposeName: "Lead synchronization",
    health: "healthy",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "interval:5@UTC",
    lastAcceptableEvidenceAt: "4 minutes ago",
    nextDeadlineAt: "in 1 minute",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "200 to 2,000",
      currentCount: "1,847",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "medium",
    },
  }),
  contract({
    contractId: "w-orders",
    workflowId: "w-orders",
    clientId: "c-nw",
    businessPurposeName: "Order fulfillment handoff",
    health: "healthy",
    evidenceLevel: "high",
    expectedCadenceOrWindow: "interval:10@UTC",
    lastAcceptableEvidenceAt: "8 minutes ago",
    nextDeadlineAt: "in 2 minutes",
    volumeSummary: {
      label: "Hourly reported volume",
      expectedRange: "50 to 800",
      currentCount: "412",
      windowEndsLabel: "top of next hour",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "high",
    },
  }),
  contract({
    contractId: "w-inventory",
    workflowId: "w-inventory",
    clientId: "c-nw",
    businessPurposeName: "Nightly inventory reconcile",
    health: "healthy",
    evidenceLevel: "high",
    expectedCadenceOrWindow: "cron:0 2 * * *@UTC",
    lastAcceptableEvidenceAt: "6 hours ago",
    nextDeadlineAt: "in 18 hours",
    volumeSummary: {
      label: "Nightly SKU count",
      expectedRange: "12,000 to 14,000",
      currentCount: "13,204",
      windowEndsLabel: "02:00 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "high",
    },
  }),
  contract({
    contractId: "w-hubspot",
    workflowId: "w-hubspot",
    clientId: "c-acme",
    businessPurposeName: "HubSpot contact sync",
    health: "warning",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "interval:30@UTC",
    lastAcceptableEvidenceAt: "28 minutes ago",
    nextDeadlineAt: "in 2 minutes",
    connectorHealth: "healthy",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "500 to 5,000",
      currentCount: "2,103",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 2,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-invoice",
    workflowId: "w-invoice",
    clientId: "c-summit",
    businessPurposeName: "Invoice export to ERP",
    health: "overdue",
    expectedCadenceOrWindow: "interval:60@UTC",
    lastAcceptableEvidenceAt: "2 hours 14 minutes ago",
    nextDeadlineAt: "1 hour 14 minutes overdue",
    overdueDurationSeconds: 4440,
    activeIncident: {
      severity: "critical",
      summary: "Silent absence",
    },
    alertChannelHealth: "healthy",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "20 to 400",
      currentCount: "0",
      windowEndsLabel: "today 23:59 UTC",
      status: "Below minimum",
      unknownCountEvents: 0,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-claims",
    workflowId: "w-claims",
    clientId: "c-harbor",
    businessPurposeName: "Claims batch to core system",
    health: "overdue",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "interval:15@UTC",
    lastAcceptableEvidenceAt: "47 minutes ago",
    nextDeadlineAt: "32 minutes overdue",
    overdueDurationSeconds: 1920,
    activeIncident: {
      severity: "critical",
      summary: "Hard failure",
    },
    volumeSummary: {
      label: "Hourly reported volume",
      expectedRange: "40 to 600",
      currentCount: "0",
      windowEndsLabel: "top of next hour",
      status: "Below minimum",
      unknownCountEvents: 1,
      evidenceLevel: "medium",
    },
  }),
  contract({
    contractId: "w-onboard",
    workflowId: "w-onboard",
    clientId: "c-lake",
    businessPurposeName: "Patient onboarding emails",
    health: "healthy",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "interval:15@UTC",
    lastAcceptableEvidenceAt: "11 minutes ago",
    nextDeadlineAt: "in 4 minutes",
    connectorHealth: "healthy",
    alertChannelHealth: "healthy",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "30 to 250",
      currentCount: "96",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-dispatch",
    workflowId: "w-dispatch",
    clientId: "c-bright",
    businessPurposeName: "Carrier dispatch notifications",
    health: "warning",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "interval:5@UTC",
    lastAcceptableEvidenceAt: "9 minutes ago",
    nextDeadlineAt: "in 1 minute",
    connectorHealth: "degraded",
    volumeSummary: {
      label: "Hourly reported volume",
      expectedRange: "80 to 1,200",
      currentCount: "1,184",
      windowEndsLabel: "top of next hour",
      status: "Near maximum",
      unknownCountEvents: 0,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-payroll",
    workflowId: "w-payroll",
    clientId: "c-summit",
    businessPurposeName: "Weekly payroll feed",
    health: "healthy",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "cron:0 6 * * 1@Europe/Warsaw",
    lastAcceptableEvidenceAt: "3 days ago",
    nextDeadlineAt: "in 4 days",
    volumeSummary: {
      label: "Weekly row count",
      expectedRange: "800 to 1,200",
      currentCount: "1,044",
      windowEndsLabel: "Monday 06:00",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "medium",
    },
  }),
  contract({
    contractId: "w-shipments",
    workflowId: "w-shipments",
    clientId: "c-bright",
    businessPurposeName: "Shipment status webhook fan-out",
    health: "healthy",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "event_driven:90@UTC",
    lastAcceptableEvidenceAt: "6 minutes ago",
    nextDeadlineAt: "in 84 minutes",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "1,000 to 8,000",
      currentCount: "4,621",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "medium",
    },
  }),
  contract({
    contractId: "o-zoom",
    workflowId: null,
    clientId: "c-acme",
    businessPurposeName: "Webinar registrant sync (Preview)",
    health: "warning",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "event_driven:120@UTC",
    lastAcceptableEvidenceAt: "47 minutes ago",
    nextDeadlineAt: "in 73 minutes",
    contractKind: "outcome",
    sourceCount: 1840,
    destinationCount: 1826,
    missingCount: 14,
    oldestMissingAgeSeconds: 7200,
    volumeSummary: null,
  }),
  contract({
    contractId: "o-policy",
    workflowId: null,
    clientId: "c-harbor",
    businessPurposeName: "Policy renewal notices (Preview)",
    health: "overdue",
    evidenceLevel: "high",
    expectedCadenceOrWindow: "cron:0 9 * * 1-5@America/New_York",
    lastAcceptableEvidenceAt: "1 day ago",
    nextDeadlineAt: "5 hours overdue",
    overdueDurationSeconds: 18000,
    contractKind: "outcome",
    sourceCount: 420,
    destinationCount: 388,
    missingCount: 32,
    oldestMissingAgeSeconds: 54000,
    activeIncident: {
      severity: "warning",
      summary: "Missing outcomes",
    },
    volumeSummary: null,
  }),
  contract({
    contractId: "w-chargebacks",
    workflowId: "w-chargebacks",
    clientId: "c-summit",
    businessPurposeName: "Stripe chargeback ingest",
    health: "healthy",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "interval:30@UTC",
    lastAcceptableEvidenceAt: "19 minutes ago",
    nextDeadlineAt: "in 11 minutes",
    alertChannelHealth: "degraded",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "0 to 40",
      currentCount: "3",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-appointments",
    workflowId: "w-appointments",
    clientId: "c-lake",
    businessPurposeName: "Appointment reminder SMS",
    health: "healthy",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "interval:20@UTC",
    lastAcceptableEvidenceAt: "7 minutes ago",
    nextDeadlineAt: "in 13 minutes",
    connectorHealth: "healthy",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "100 to 900",
      currentCount: "514",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 0,
      evidenceLevel: "basic",
    },
  }),
  contract({
    contractId: "w-returns",
    workflowId: "w-returns",
    clientId: "c-nw",
    businessPurposeName: "Returns RMA sync",
    health: "warning",
    evidenceLevel: "medium",
    expectedCadenceOrWindow: "interval:15@UTC",
    lastAcceptableEvidenceAt: "22 minutes ago",
    nextDeadlineAt: "in 8 minutes",
    volumeSummary: {
      label: "Daily reported volume",
      expectedRange: "10 to 300",
      currentCount: "8",
      windowEndsLabel: "today 23:59 UTC",
      status: "Below minimum",
      unknownCountEvents: 0,
      evidenceLevel: "medium",
    },
  }),
  contract({
    contractId: "w-purge",
    workflowId: "w-purge",
    clientId: "c-nw",
    businessPurposeName: "Marketing list purge",
    health: "inactive",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "cron:0 3 * * 0@UTC",
    lastAcceptableEvidenceAt: "12 days ago",
    nextDeadlineAt: null,
    isActive: false,
    alertChannelHealth: "none",
  }),
  contract({
    contractId: "w-archive",
    workflowId: "w-archive",
    clientId: "c-acme",
    businessPurposeName: "Quarterly CRM archive",
    health: "inactive",
    evidenceLevel: "basic",
    expectedCadenceOrWindow: "cron:0 4 1 1,4,7,10 *@UTC",
    lastAcceptableEvidenceAt: "89 days ago",
    nextDeadlineAt: null,
    isActive: false,
    alertChannelHealth: "none",
  }),
];

fs.writeFileSync(
  path.join(dir, "onboarding-method.html"),
  renderOnboardingPage({ csrf: "x", step: "choose_method", method: null }),
);
fs.writeFileSync(
  path.join(dir, "workflow-registration.html"),
  renderWorkflowsPage({
    csrf: "x",
    workflows: [
      {
        id: "w-leads",
        name: "Lead sync · production",
        externalWorkflowId: "n8n-prod-leads-01",
        monitoringMethod: "push",
        isActive: true,
      },
      {
        id: "w-orders",
        name: "Order handoff · production",
        externalWorkflowId: "n8n-prod-orders-02",
        monitoringMethod: "push",
        isActive: true,
      },
      {
        id: "w-onboard",
        name: "Patient onboarding · poll",
        externalWorkflowId: "n8n-prod-onboard-07",
        monitoringMethod: "poll",
        isActive: true,
        connectorId: "conn-lake-n8n",
      },
      {
        id: "w-claims",
        name: "Claims batch · poll",
        externalWorkflowId: "n8n-prod-claims-11",
        monitoringMethod: "poll",
        isActive: true,
        connectorId: "conn-harbor-n8n",
      },
      {
        id: "w-dispatch",
        name: "Carrier dispatch · poll",
        externalWorkflowId: "n8n-prod-dispatch-04",
        monitoringMethod: "poll",
        isActive: true,
        connectorId: "conn-bright-n8n",
      },
      {
        id: "w-invoice",
        name: "Invoice export · production",
        externalWorkflowId: "n8n-prod-invoice-03",
        monitoringMethod: "push",
        isActive: true,
      },
      {
        id: "w-shipments",
        name: "Shipment fan-out · production",
        externalWorkflowId: "n8n-prod-ship-09",
        monitoringMethod: "push",
        isActive: true,
      },
      {
        id: "w-appointments",
        name: "Appointment SMS · poll",
        externalWorkflowId: "n8n-prod-appt-12",
        monitoringMethod: "poll",
        isActive: true,
        connectorId: "conn-lake-n8n",
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(dir, "protect-contract.html"),
  renderProtectClientPage({
    csrf: "x",
    step: 4,
    clients,
    draft: {
      clientId: "c-acme",
      workflowId: "w-leads",
      businessPurpose: "Lead synchronization",
      cadenceValue: "5",
    },
  }),
);
fs.writeFileSync(
  path.join(dir, "catalog.html"),
  renderCatalogPage({
    csrf: "x",
    role: "admin",
    clients,
    filters: {},
    banner:
      "2 contracts have degraded alert delivery. 1 connector is degraded. Delivery problems do not change whether workflows are overdue.",
    summary: {
      contractsCurrentlySatisfied: 22,
      clientProcessesNeedingAttention: 6,
      outcomesMissingOrDelayed: 2,
      contractsWithOnlyBasicEvidence: 11,
      clientsWithFailingAlertDelivery: 2,
      contractsNotYetActivated: 1,
    },
    contracts: catalogContracts,
  }),
);
fs.writeFileSync(
  path.join(dir, "contract-detail.html"),
  renderWorkflowContractDetailPage({
    role: "admin",
    csrf: "x",
    contract: {
      name: "Lead sync · production",
      businessPurpose: "Lead synchronization",
      cadence: "interval:5@UTC",
      isActive: true,
      evidenceLevel: "medium",
      health: "healthy",
      lastEvidence: "4 minutes ago",
      nextDeadline: "in 1 minute",
      verified: [
        "execution reported on schedule",
        "aggregate destination row count within band",
        "HMAC signature verified for push heartbeats",
      ],
      unverified: [
        "individual CRM field mapping",
        "duplicate suppression at destination",
        "owner assignment after create/update",
      ],
      raiseHint:
        "Add per-record reconciliation to raise evidence from Medium to High.",
    },
    incidents: [
      {
        summary: "Volume below minimum (resolved)",
        status: "resolved",
        severity: "warning",
      },
      {
        summary: "Silent absence (resolved)",
        status: "resolved",
        severity: "critical",
      },
      {
        summary: "Empty result burst (resolved)",
        status: "resolved",
        severity: "warning",
      },
      {
        summary: "Alert delivery degraded (resolved)",
        status: "resolved",
        severity: "warning",
      },
    ],
    channels: [
      { name: "Ops Slack webhook", health: "healthy" },
      { name: "Pager email (SMTP)", health: "healthy" },
      { name: "Acme on-call SMS", health: "healthy" },
      { name: "Status page webhook", health: "degraded" },
    ],
    recentEvents: [
      { at: "2026-07-22T14:02:00Z", label: "success · 312 items" },
      { at: "2026-07-22T13:57:00Z", label: "success · 298 items" },
      { at: "2026-07-22T13:52:00Z", label: "success · 305 items" },
      { at: "2026-07-22T13:47:00Z", label: "success · 287 items" },
      { at: "2026-07-22T13:42:00Z", label: "success · 319 items" },
      { at: "2026-07-22T13:37:00Z", label: "success · 301 items" },
      { at: "2026-07-21T09:18:00Z", label: "incident resolved · empty result burst" },
      { at: "2026-07-21T08:55:00Z", label: "incident opened · empty result burst" },
      { at: "2026-07-19T08:14:00Z", label: "incident resolved · silent absence" },
      { at: "2026-07-19T07:02:00Z", label: "incident opened · silent absence" },
      { at: "2026-07-12T16:30:00Z", label: "incident resolved · volume below minimum" },
      { at: "2026-07-12T16:22:00Z", label: "incident opened · volume below minimum" },
      { at: "2026-06-28T09:00:00Z", label: "contract activated" },
      { at: "2026-06-27T15:40:00Z", label: "push credential issued" },
    ],
    volume: {
      label: "Daily reported volume",
      expectedRange: "200 to 2,000",
      currentCount: "1,847",
      windowEndsLabel: "today 23:59 UTC",
      status: "Within range",
      unknownCountEvents: 1,
      verified: ["workflow reported execution counts each run"],
      unverified: ["exact destination record totals", "per-owner lead attribution"],
    },
  }),
);
fs.writeFileSync(
  path.join(dir, "incidents.html"),
  renderSimpleNavPage({
    title: "Incidents",
    current: "incidents",
    role: "admin",
    body: `<h1 class="page-title">Incidents</h1>
      <p class="page-subtitle helper">218 incidents in the last 90 days · 4 open</p>
      <div class="card table-wrap" style="padding:0">
        <table class="responsive-cards">
          <thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th></tr></thead>
          <tbody>
            <tr>
              <td data-label="Severity" class="sev-critical">critical</td>
              <td data-label="Status">open</td>
              <td data-label="Summary">Silent absence · Invoice export to ERP (Summit Finance)</td>
              <td data-label="Opened" class="helper">2026-07-21T11:48:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-critical">critical</td>
              <td data-label="Status">open</td>
              <td data-label="Summary">Hard failure · Claims batch to core system (Harbor Mutual)</td>
              <td data-label="Opened" class="helper">2026-07-22T13:15:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">open</td>
              <td data-label="Summary">Missing outcomes · Policy renewal notices (Harbor Mutual)</td>
              <td data-label="Opened" class="helper">2026-07-22T09:05:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">open</td>
              <td data-label="Summary">Volume near maximum · Carrier dispatch notifications (Brightline Logistics)</td>
              <td data-label="Opened" class="helper">2026-07-22T12:40:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Volume below minimum · Lead synchronization (Acme Agency)</td>
              <td data-label="Opened" class="helper">2026-07-12T16:22:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-critical">critical</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Silent absence · Lead synchronization (Acme Agency)</td>
              <td data-label="Opened" class="helper">2026-07-19T07:02:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Empty result · HubSpot contact sync (Acme Agency)</td>
              <td data-label="Opened" class="helper">2026-07-08T14:11:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-critical">critical</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Hard failure · Order fulfillment handoff (Northwind Retail)</td>
              <td data-label="Opened" class="helper">2026-06-30T03:18:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Volume above maximum · Patient onboarding emails (Lakeview Health)</td>
              <td data-label="Opened" class="helper">2026-06-14T09:44:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-critical">critical</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Silent absence · Shipment status webhook fan-out (Brightline Logistics)</td>
              <td data-label="Opened" class="helper">2026-06-22T21:03:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Connector degraded · Appointment reminder SMS (Lakeview Health)</td>
              <td data-label="Opened" class="helper">2026-07-02T18:27:00Z</td>
            </tr>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">resolved</td>
              <td data-label="Summary">Volume below minimum · Returns RMA sync (Northwind Retail)</td>
              <td data-label="Opened" class="helper">2026-07-05T11:09:00Z</td>
            </tr>
          </tbody>
        </table>
      </div>`,
  }),
);
fs.writeFileSync(
  path.join(dir, "mobile-onboarding.html"),
  renderOnboardingPage({
    csrf: "x",
    step: "select_workflows",
    method: "push",
  }),
);

fs.writeFileSync(
  path.join(dir, "alerts.html"),
  renderAlertsPage({
    csrf: "x",
    channels: [
      { id: "ch-slack", name: "Ops Slack webhook", type: "webhook", health: "healthy" },
      { id: "ch-pager", name: "Pager email (SMTP)", type: "webhook", health: "healthy" },
      { id: "ch-sms", name: "Acme on-call SMS", type: "webhook", health: "healthy" },
      { id: "ch-status", name: "Status page webhook", type: "webhook", health: "degraded" },
      { id: "ch-harbor", name: "Harbor Mutual ops", type: "webhook", health: "failing" },
    ],
  }),
);

const protectWorkflows = [
  {
    id: "w-leads",
    name: "Lead sync · production",
    externalWorkflowId: "n8n-prod-leads-01",
    monitoringMethod: "push",
  },
  {
    id: "w-onboard",
    name: "Patient onboarding · poll",
    externalWorkflowId: "n8n-prod-onboard-07",
    monitoringMethod: "poll",
  },
  {
    id: "w-claims",
    name: "Claims batch · poll",
    externalWorkflowId: "n8n-prod-claims-11",
    monitoringMethod: "poll",
  },
];

fs.writeFileSync(
  path.join(dir, "protect-workflow.html"),
  renderProtectClientPage({
    csrf: "x",
    step: 3,
    clients,
    workflows: protectWorkflows,
    draft: {
      clientId: "c-acme",
      businessPurpose: "Nightly reconciliation export",
      templateId: "lead_delivery",
    },
  }),
);

fs.writeFileSync(
  path.join(dir, "protect-alerts.html"),
  renderProtectClientPage({
    csrf: "x",
    step: 5,
    clients,
    draft: {
      clientId: "c-acme",
      workflowId: "w-new-recon",
      contractId: "ct-new-recon",
      businessPurpose: "Nightly reconciliation export",
    },
  }),
);

fs.writeFileSync(
  path.join(dir, "protect-activate.html"),
  renderProtectClientPage({
    csrf: "x",
    step: 6,
    clients,
    draft: {
      clientId: "c-acme",
      workflowId: "w-new-recon",
      contractId: "ct-new-recon",
      acknowledgedNoAlertMode: "1",
    },
  }),
);

console.log(`Wrote UI previews to ${dir}`);
