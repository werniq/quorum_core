import { describe, expect, it } from "vitest";
import {
  buildHardFailureDetails,
  formatHardFailureRecoverySummary,
  formatHardFailureSummary,
  formatHeartbeatHistoryRow,
  parseHardFailureDetails,
  withHardFailureRecovery,
} from "../../src/domain/incidents/hard-failure.js";
import {
  hardFailureActions,
  renderHardFailureIncidentCard,
  type IncidentListRow,
} from "../../src/presentation/html/incidents-ui.js";

describe("hard-failure domain helpers", () => {
  it("formats human-readable heartbeat history rows", () => {
    expect(
      formatHeartbeatHistoryRow({
        at: "2026-07-30T17:59:12.000Z",
        status: "failure",
        itemsProcessed: 0,
      }),
    ).toBe("17:59 · Failure · 0 items");
    expect(
      formatHeartbeatHistoryRow({
        at: "2026-07-30T17:55:00.000Z",
        status: "success",
        itemsProcessed: 8,
      }),
    ).toBe("17:55 · Success · 8 items");
  });

  it("accumulates consecutive failures and recovery metadata", () => {
    const first = buildHardFailureDetails({
      existing: null,
      workflowName: "Invoice sync",
      monitoringMethod: "push",
      observedAt: "2026-07-30T17:00:00.000Z",
      latestStatus: "failure",
      itemsProcessed: 0,
      externalExecutionRef: "exec-1",
    });
    expect(first.consecutiveFailures).toBe(1);
    const second = buildHardFailureDetails({
      existing: first,
      workflowName: "Invoice sync",
      monitoringMethod: "push",
      observedAt: "2026-07-30T17:05:00.000Z",
      latestStatus: "failure",
      itemsProcessed: 0,
      externalExecutionRef: "exec-2",
    });
    expect(second.consecutiveFailures).toBe(2);
    expect(second.firstFailureAt).toBe("2026-07-30T17:00:00.000Z");
    expect(formatHardFailureSummary(second)).toContain("2 consecutive");
    expect(formatHardFailureSummary(second)).toContain("Invoice sync");

    const recovered = withHardFailureRecovery(
      second,
      "2026-07-30T17:10:00.000Z",
    );
    expect(recovered.durationSeconds).toBe(600);
    expect(formatHardFailureRecoverySummary(recovered)).toContain("recovered");
    expect(formatHardFailureRecoverySummary(recovered)).toContain(
      "duration 10m",
    );
    expect(
      parseHardFailureDetails(JSON.stringify(recovered))?.recoveredAt,
    ).toBe("2026-07-30T17:10:00.000Z");
  });
});

describe("hard-failure incident UI", () => {
  const row: IncidentListRow = {
    id: "hf-1",
    severity: "critical",
    status: "open",
    summary: "Invoice sync: hard failure · 2 consecutive",
    openedAt: "2026-07-30T17:00:00.000Z",
    resolvedAt: null,
    detailsJson: JSON.stringify(
      buildHardFailureDetails({
        existing: buildHardFailureDetails({
          existing: null,
          workflowName: "Invoice sync",
          monitoringMethod: "push",
          observedAt: "2026-07-30T17:00:00.000Z",
          latestStatus: "failure",
          itemsProcessed: 0,
          externalExecutionRef: "exec-1",
        }),
        workflowName: "Invoice sync",
        monitoringMethod: "push",
        observedAt: "2026-07-30T17:05:00.000Z",
        latestStatus: "failure",
        itemsProcessed: 0,
        externalExecutionRef: "exec-2",
      }),
    ),
    incidentType: "hard_failure",
    workflowId: "wf-1",
    workflowName: "Invoice sync",
    monitoringMethod: "push",
    externalWorkflowId: "n8nWorkflowAbc",
    connectorBaseUrl: "https://n8n.example.com",
    lastAcceptableEvidenceAt: null,
    nextExpectedAt: null,
    overdueSince: null,
  };

  it("renders actionable hard-failure cards with n8n and acknowledge", () => {
    const labels = hardFailureActions(row, "csrf-token").map((a) => a.label);
    expect(labels).toEqual([
      "Open workflow in n8n",
      "View latest report",
      "Acknowledge incident",
      "View contract",
    ]);
    const html = renderHardFailureIncidentCard(row, "csrf-token");
    expect(html).toContain("Invoice sync");
    expect(html).toContain("First failure");
    expect(html).toContain("Latest failure");
    expect(html).toContain("Consecutive failures: 2");
    expect(html).toContain("Push heartbeats");
    expect(html).toContain("Items processed: 0");
    expect(html).toContain("exec-2");
    expect(html).toContain('href="/catalog/contracts/wf-1#sec-timeline"');
    expect(html).toContain('action="/incidents/hf-1/acknowledge"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("Heartbeat reported hard failure");
  });

  it("shows recovery time and duration after resolve", () => {
    const details = withHardFailureRecovery(
      parseHardFailureDetails(row.detailsJson)!,
      "2026-07-30T17:12:00.000Z",
    );
    const recovered: IncidentListRow = {
      ...row,
      status: "resolved",
      resolvedAt: "2026-07-30T17:12:00.000Z",
      summary: formatHardFailureRecoverySummary(details),
      detailsJson: JSON.stringify(details),
    };
    const html = renderHardFailureIncidentCard(recovered, "csrf-token");
    expect(html).toContain("Recovered");
    expect(html).toContain("Incident duration:");
    expect(html).toContain("12m");
    expect(html).not.toContain("Acknowledge incident");
  });
});
