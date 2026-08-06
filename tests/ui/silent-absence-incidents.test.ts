import { describe, expect, it } from "vitest";
import {
  buildN8nWorkflowEditorUrl,
  isValidN8nExternalWorkflowId,
  SILENT_ABSENCE_MESSAGE,
} from "../../src/domain/n8n/workflow-editor-url.js";
import {
  renderSilentAbsenceIncidentCard,
  silentAbsenceActions,
  type IncidentListRow,
} from "../../src/presentation/html/incidents-ui.js";

function baseIncident(
  overrides: Partial<IncidentListRow> = {},
): IncidentListRow {
  return {
    id: "inc-1",
    severity: "critical",
    status: "open",
    summary: SILENT_ABSENCE_MESSAGE,
    openedAt: "2026-07-30T14:00:00.000Z",
    resolvedAt: null,
    lifecycleStatus: "active",
    acknowledgmentStatus: "unacknowledged",
    recoveredAt: null,
    recoveryEvidence: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgmentNote: null,
    detailsJson: null,
    incidentType: "silent_absence",
    workflowId: "wf-1",
    workflowName: "Invoice sync",
    monitoringMethod: "push",
    externalWorkflowId: "n8nWorkflowAbc",
    connectorBaseUrl: "https://n8n.example.com",
    lastAcceptableEvidenceAt: "2026-07-30T12:00:00.000Z",
    nextExpectedAt: "2026-07-30T13:00:00.000Z",
    overdueSince: "2026-07-30T13:05:00.000Z",
    ...overrides,
  };
}

describe("n8n workflow editor URL", () => {
  it("builds a workflow URL from a valid base URL and external id", () => {
    expect(
      buildN8nWorkflowEditorUrl({
        baseUrl: "https://n8n.example.com/",
        externalWorkflowId: "n8nWorkflowAbc",
      }),
    ).toBe("https://n8n.example.com/workflow/n8nWorkflowAbc");
  });

  it("rejects missing n8n base URL", () => {
    expect(
      buildN8nWorkflowEditorUrl({
        baseUrl: null,
        externalWorkflowId: "n8nWorkflowAbc",
      }),
    ).toBeNull();
    expect(
      buildN8nWorkflowEditorUrl({
        baseUrl: "   ",
        externalWorkflowId: "n8nWorkflowAbc",
      }),
    ).toBeNull();
  });

  it("rejects invalid external workflow IDs", () => {
    expect(isValidN8nExternalWorkflowId("../etc/passwd")).toBe(false);
    expect(isValidN8nExternalWorkflowId("id with spaces")).toBe(false);
    expect(isValidN8nExternalWorkflowId("javascript:alert(1)")).toBe(false);
    expect(
      buildN8nWorkflowEditorUrl({
        baseUrl: "https://n8n.example.com",
        externalWorkflowId: "../evil",
      }),
    ).toBeNull();
    expect(
      buildN8nWorkflowEditorUrl({
        baseUrl: "javascript:alert(1)",
        externalWorkflowId: "n8nWorkflowAbc",
      }),
    ).toBeNull();
  });
});

describe("silent-absence incident actions", () => {
  const nowMs = Date.parse("2026-07-30T15:00:00.000Z");

  it("offers push actions with an n8n link when available", () => {
    const row = baseIncident({ monitoringMethod: "push" });
    const labels = silentAbsenceActions(row).map((a) => a.label);
    expect(labels).toEqual([
      "Open workflow in n8n",
      "Check heartbeat setup",
      "View contract",
    ]);
    const html = renderSilentAbsenceIncidentCard(row, nowMs);
    expect(html).toContain(SILENT_ABSENCE_MESSAGE);
    expect(html).toContain("Invoice sync");
    expect(html).toContain("Push heartbeats");
    expect(html).toContain("Last accepted execution");
    expect(html).toContain("Expected deadline");
    expect(html).toContain("How late:");
    expect(html).toContain('href="/catalog/contracts/wf-1"');
    expect(html).toContain(
      'href="https://n8n.example.com/workflow/n8nWorkflowAbc"',
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("failed");
  });

  it("offers polling actions with Check connector", () => {
    const row = baseIncident({
      monitoringMethod: "poll",
      connectorBaseUrl: "http://n8n:5678",
      externalWorkflowId: "pollWorkflow1",
    });
    const actions = silentAbsenceActions(row);
    expect(actions.map((a) => a.label)).toEqual([
      "Open workflow in n8n",
      "Check connector",
      "View contract",
    ]);
    expect(actions[0]?.href).toBe("http://n8n:5678/workflow/pollWorkflow1");
    const html = renderSilentAbsenceIncidentCard(row, nowMs);
    expect(html).toContain("Connect n8n (polling)");
    expect(html).toContain('href="/connectors"');
    expect(html).toContain("Check connector");
    expect(html).not.toContain("Check heartbeat setup");
  });

  it("omits the n8n link when the base URL is missing", () => {
    const row = baseIncident({
      monitoringMethod: "push",
      connectorBaseUrl: null,
    });
    const actions = silentAbsenceActions(row);
    expect(actions.map((a) => a.label)).toEqual([
      "Check heartbeat setup",
      "View contract",
    ]);
    const html = renderSilentAbsenceIncidentCard(row, nowMs);
    expect(html).not.toContain("Open workflow in n8n");
    expect(html).not.toContain("/workflow/");
  });

  it("omits the n8n link when the external workflow ID is invalid", () => {
    const row = baseIncident({
      monitoringMethod: "poll",
      externalWorkflowId: "bad id!",
      connectorBaseUrl: "https://n8n.example.com",
    });
    const actions = silentAbsenceActions(row);
    expect(actions.map((a) => a.label)).toEqual([
      "Check connector",
      "View contract",
    ]);
    const html = renderSilentAbsenceIncidentCard(row, nowMs);
    expect(html).not.toContain("Open workflow in n8n");
    expect(html).toContain('href="/connectors"');
  });
});
