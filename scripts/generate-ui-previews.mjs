import fs from "node:fs";
import path from "node:path";
import {
  renderOnboardingPage,
  renderWorkflowsPage,
} from "../src/presentation/html/pages.ts";
import {
  renderCatalogPage,
  renderProtectClientPage,
  renderSimpleNavPage,
  renderWorkflowContractDetailPage,
} from "../src/presentation/html/catalog-ui.ts";

const dir = path.join("docs", "verification", "ui-preview");
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(
  path.join(dir, "onboarding-method.html"),
  renderOnboardingPage({ csrf: "x", step: "choose_method", method: null }),
);
fs.writeFileSync(
  path.join(dir, "workflow-registration.html"),
  renderWorkflowsPage({ csrf: "x", workflows: [] }),
);
fs.writeFileSync(
  path.join(dir, "protect-contract.html"),
  renderProtectClientPage({
    csrf: "x",
    step: 4,
    clients: [{ id: "1", name: "Agency Org" }],
    draft: {
      clientId: "1",
      workflowId: "w1",
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
    clients: [{ id: "1", name: "Agency Org" }],
    filters: {},
    summary: {
      contractsCurrentlySatisfied: 1,
      clientProcessesNeedingAttention: 0,
      outcomesMissingOrDelayed: 0,
      contractsWithOnlyBasicEvidence: 1,
      clientsWithFailingAlertDelivery: 0,
      contractsNotYetActivated: 0,
    },
    contracts: [
      {
        contractId: "c1",
        workflowId: "w1",
        clientId: "1",
        clientName: "Agency Org",
        businessPurposeName: "Lead synchronization",
        health: "healthy",
        evidenceLevel: "basic",
        evidenceExplanation: "Basic — destination not independently checked",
        expectedCadenceOrWindow: "interval:5@UTC",
        lastAcceptableEvidenceAt: "2 minutes ago",
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
        volumeSummary: {
          label: "Daily reported volume",
          expectedRange: "20 to 100",
          currentCount: "42",
          windowEndsLabel: "Sunday 23:59",
          status: "Collecting",
          unknownCountEvents: 0,
          evidenceLevel: "basic",
        },
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(dir, "contract-detail.html"),
  renderWorkflowContractDetailPage({
    role: "admin",
    csrf: "x",
    contract: {
      name: "Lead sync",
      businessPurpose: "Lead synchronization",
      cadence: "every 5 minutes",
      isActive: true,
      evidenceLevel: "basic",
      health: "healthy",
      lastEvidence: "2 minutes ago",
      nextDeadline: "in 3 minutes",
      verified: ["execution reported"],
      unverified: ["destination delivery"],
      raiseHint: "Add destination reconciliation to raise evidence.",
    },
    incidents: [
      {
        summary: "Volume below minimum",
        status: "open",
        severity: "warning",
      },
    ],
    channels: [{ name: "Ops webhook", health: "healthy" }],
    recentEvents: [{ at: "2026-07-20T10:00:00Z", label: "success" }],
    volume: {
      label: "Daily reported volume",
      expectedRange: "20 to 100",
      currentCount: "42",
      windowEndsLabel: "Sunday 23:59 Europe/Warsaw",
      status: "Collecting",
      unknownCountEvents: 0,
      verified: ["workflow reported executions"],
      unverified: ["exact destination records"],
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
      <div class="card table-wrap" style="padding:0">
        <table class="responsive-cards">
          <thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th></tr></thead>
          <tbody>
            <tr>
              <td data-label="Severity" class="sev-warning">warning</td>
              <td data-label="Status">open</td>
              <td data-label="Summary">Volume below minimum for Lead synchronization</td>
              <td data-label="Opened" class="helper">2026-07-20T09:00:00Z</td>
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

console.log(`Wrote UI previews to ${dir}`);
