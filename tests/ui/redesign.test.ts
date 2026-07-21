import { describe, expect, it } from "vitest";
import {
  onboardingStepLabel,
  ONBOARDING_STEP_LABELS,
  renderStepper,
  statusBadge,
  evidenceBadge,
  layout,
} from "../../src/presentation/html/layout.js";
import {
  renderOnboardingPage,
  renderWorkflowsPage,
} from "../../src/presentation/html/pages.js";
import {
  renderCatalogPage,
  renderProtectClientPage,
} from "../../src/presentation/html/catalog-ui.js";

describe("UI redesign copy and primitives", () => {
  it("maps onboarding step ids to human-readable labels without underscores", () => {
    for (const [id, label] of Object.entries(ONBOARDING_STEP_LABELS)) {
      expect(label).not.toMatch(/_/);
      expect(onboardingStepLabel(id)).toBe(label);
    }
    expect(onboardingStepLabel("choose_method")).toBe("Monitoring method");
    expect(onboardingStepLabel("select_workflows")).toBe("Select workflow");
  });

  it("renders stepper with completed, current, and future steps", () => {
    const html = renderStepper({
      steps: [
        { id: "choose_method", label: "Monitoring method" },
        { id: "select_workflows", label: "Select workflow" },
        { id: "define_contracts", label: "Define contract" },
      ],
      currentId: "select_workflows",
    });
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("is-complete");
    expect(html).toContain("is-current");
    expect(html).toContain("Step 2 of 3");
    expect(html).toContain("Monitoring method");
    expect(html).not.toContain("choose_method");
  });

  it("separates health and evidence badges with text labels", () => {
    expect(statusBadge("healthy")).toContain("Healthy");
    expect(statusBadge("overdue")).toContain("Overdue");
    expect(evidenceBadge("basic")).toContain("Basic evidence");
    expect(evidenceBadge("high", true)).toContain("stale");
  });

  it("onboarding method step uses radio cards and readable labels", () => {
    const html = renderOnboardingPage({
      csrf: "csrf-token",
      step: "choose_method",
      method: null,
    });
    expect(html).toContain("Monitoring method");
    expect(html).toContain("Push heartbeats");
    expect(html).toContain("Recommended");
    expect(html).toContain("Connect n8n");
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain(">choose_method<");
    expect(html).toContain("--font-sans: Inter");
    expect(html).not.toContain("Georgia");
    expect(html).not.toMatch(/fonts\.googleapis|cdn\.jsdelivr/i);
  });

  it("lists registered workflows on the select step and allows multiple", () => {
    const html = renderOnboardingPage({
      csrf: "csrf-token",
      step: "select_workflows",
      method: "push",
      workflows: [
        {
          id: "wf-1",
          name: "Lead sync",
          externalWorkflowId: "n8n-abc",
          monitoringMethod: "push",
        },
      ],
    });
    expect(html).toContain("Registered workflows");
    expect(html).toContain("Lead sync");
    expect(html).toContain("n8n-abc");
    expect(html).toContain("Register another workflow");
    expect(html).toContain("Continue to contract");
  });

  it("lists saved contracts on the define step", () => {
    const html = renderOnboardingPage({
      csrf: "csrf-token",
      step: "define_contracts",
      method: "push",
      workflows: [
        {
          id: "wf-1",
          name: "Lead sync",
          externalWorkflowId: "n8n-abc",
          monitoringMethod: "push",
        },
      ],
      contracts: [
        {
          id: "c-1",
          name: "Lead delivery heartbeat",
          workflowName: "Lead sync",
          cadenceType: "interval",
          cadenceValue: "15",
          isActive: false,
        },
      ],
    });
    expect(html).toContain("Saved contracts");
    expect(html).toContain("Lead delivery heartbeat");
    expect(html).toContain("Lead sync");
    expect(html).toContain("interval: 15");
    expect(html).toContain("Define another contract");
    expect(html).toContain("Continue to evidence");
    expect(html).toContain("Save contract");
  });

  it("lists alert channels and contracts on later onboarding steps", () => {
    const alertsHtml = renderOnboardingPage({
      csrf: "csrf-token",
      step: "configure_alerts",
      method: "push",
      alertChannels: [
        {
          id: "ch-1",
          name: "Ops webhook",
          type: "webhook",
          isActive: true,
          health: "healthy",
          lastTestedAt: "2026-07-20T12:00:00.000Z",
        },
      ],
    });
    expect(alertsHtml).toContain("Alert channels");
    expect(alertsHtml).toContain("Ops webhook");
    expect(alertsHtml).toContain("Continue to activation");

    const activateHtml = renderOnboardingPage({
      csrf: "csrf-token",
      step: "activate",
      method: "push",
      contracts: [
        {
          id: "c-1",
          name: "Lead delivery heartbeat",
          workflowName: "Lead sync",
          cadenceType: "interval",
          cadenceValue: "15",
          isActive: false,
        },
      ],
    });
    expect(activateHtml).toContain('name="contractId"');
    expect(activateHtml).toContain("Lead delivery heartbeat");
    expect(activateHtml).toContain("<select");
    expect(activateHtml).not.toContain('name="contractId" required />');
  });

  it("workflow registration explains n8n workflow ID and uses stacked labels", () => {
    const html = renderWorkflowsPage({
      csrf: "csrf-token",
      workflows: [],
    });
    expect(html).toContain("n8n workflow ID");
    expect(html).toContain("http://localhost:5678/workflow/{workflow-id}");
    expect(html).toContain("Register workflow");
    expect(html).toContain("No workflows registered");
    expect(html).toContain('name="monitoringMethod" value="push"');
    expect(html).toContain("field-label");
  });

  it("protect wizard uses human-readable stepper and monitoring cards", () => {
    const html = renderProtectClientPage({
      csrf: "csrf-token",
      step: 3,
      clients: [],
    });
    expect(html).toContain("Select a workflow");
    expect(html).toContain("n8n workflow ID");
    expect(html).toContain("Push heartbeats");
    expect(html).toContain("Step 3 of 6");
    expect(html).toContain("QUORUM_WORKFLOW_ID");
    expect(html).not.toContain("choose_method");
  });

  it("protect workflow step can select an existing registered workflow", () => {
    const html = renderProtectClientPage({
      csrf: "csrf-token",
      step: 3,
      clients: [],
      workflows: [
        {
          id: "wf_quorum_1",
          name: "Lead sync",
          externalWorkflowId: "n8n-abc",
          monitoringMethod: "push",
        },
      ],
      draft: { clientId: "c1", businessPurpose: "Leads" },
    });
    expect(html).toContain('name="existingWorkflowId"');
    expect(html).toContain("wf_quorum_1");
    expect(html).toContain("n8n-abc");
    expect(html).toContain("does not create a duplicate");
    expect(html).toContain(">Continue</button>");
  });

  it("protect wizard continue buttons advance steps instead of sounding like final saves", () => {
    const step1 = renderProtectClientPage({
      csrf: "csrf-token",
      step: 1,
      clients: [],
    });
    expect(step1).toContain(">Continue</button>");
    expect(step1).not.toContain("Save client");

    const step2 = renderProtectClientPage({
      csrf: "csrf-token",
      step: 2,
      clients: [],
      draft: { clientId: "c1" },
    });
    expect(step2).toContain(">Continue</button>");
    expect(step2).not.toContain("Save process");

    const step4 = renderProtectClientPage({
      csrf: "csrf-token",
      step: 4,
      clients: [],
      draft: { clientId: "c1", workflowId: "w1" },
    });
    expect(step4).toContain(">Continue</button>");
    expect(step4).not.toContain("Save inactive contract");
  });

  it("protect and onboarding wizards expose Back controls after the first step", () => {
    const protect = renderProtectClientPage({
      csrf: "csrf-token",
      step: 3,
      clients: [],
      draft: { clientId: "c1", businessPurpose: "Leads" },
    });
    expect(protect).toContain('action="/protect/back"');
    expect(protect).toContain('form="protect-back-2"');
    expect(protect).toContain(">Back</button>");
    expect(protect).toContain('name="to" value="2"');

    const onboarding = renderOnboardingPage({
      csrf: "csrf-token",
      step: "define_contracts",
      method: "push",
      workflows: [],
    });
    expect(onboarding).toContain('action="/onboarding/advance"');
    expect(onboarding).toContain('name="to" value="select_workflows"');
    expect(onboarding).toContain(">Back</button>");
  });

  it("catalog empty state and status badges render", () => {
    const html = renderCatalogPage({
      csrf: "csrf",
      role: "admin",
      contracts: [],
      summary: {
        contractsCurrentlySatisfied: 0,
        clientProcessesNeedingAttention: 0,
        outcomesMissingOrDelayed: 0,
        contractsWithOnlyBasicEvidence: 0,
        clientsWithFailingAlertDelivery: 0,
        contractsNotYetActivated: 0,
      },
      clients: [],
      filters: {},
    });
    expect(html).toContain("No contracts yet");
    expect(html).toContain("Protect a client");
    expect(html).toContain("app-sidebar");
    expect(html).toContain('aria-label="Open navigation"');
  });

  it("auth layout has accessible labels and no remote assets", () => {
    const html = layout({
      title: "Setup",
      loggedIn: false,
      body: `<label class="field"><span class="field-label">Setup token</span><input name="setupToken" /></label>`,
    });
    expect(html).toContain("field-label");
    expect(html).toContain("auth-shell");
    expect(html).not.toMatch(/googleapis|cdn\.|analytics/i);
  });
});
