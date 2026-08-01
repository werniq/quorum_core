import { describe, expect, it } from "vitest";
import {
  formatCatalogTimestamp,
  formatExpectation,
  renderContractCard,
  type CatalogRowView,
} from "../../src/presentation/html/catalog-ui.js";

function baseRow(overrides: Partial<CatalogRowView> = {}): CatalogRowView {
  return {
    contractId: "contract-1",
    workflowId: "workflow-1",
    clientId: "client-1",
    clientName: "Acme",
    businessPurposeName: "Invoice sync",
    health: "warning",
    displayHealth: "warning",
    dimensions: {
      schedule: "breached",
      output: "not_configured",
      freshness: "not_configured",
      reconciliation: "not_configured",
      monitor: "healthy",
      watchdog: "healthy",
    },
    evidenceLevel: "basic",
    evidenceExplanation: "basic",
    expectedCadenceOrWindow: "interval:1@UTC",
    lastAcceptableEvidenceAt: "2026-07-29T20:16:00.000Z",
    lastReportAt: "2026-07-29T20:16:00.000Z",
    lastReportStatus: "success",
    lastExternalExecutionRef: null,
    consecutiveFailures: null,
    lastNonEmptySuccessAt: "2026-07-29T20:16:00.000Z",
    lastItemsProcessed: 8,
    emptyResultPolicy: null,
    nextDeadlineAt: "2026-07-29T20:17:00.000Z",
    overdueDurationSeconds: 120,
    alertChannelHealth: "none",
    connectorHealth: null,
    watcherHealth: "ok",
    processWatchdogHealth: "ok",
    sourceWatermarkRequired: false,
    emptyResultBreachThreshold: 1,
    monitoringMethod: "push",
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
    ...overrides,
  };
}

describe("catalog card polish formatting", () => {
  it("formats interval cadence as readable expectation text", () => {
    expect(formatExpectation("interval:1@UTC")).toBe("Every 1 minute · UTC");
    expect(formatExpectation("interval:1m@UTC")).toBe("Every 1 minute · UTC");
    expect(formatExpectation("interval:15@UTC")).toBe("Every 15 minutes · UTC");
    expect(formatExpectation("interval:60")).toBe("Every 1 hour");
    expect(formatExpectation("interval:1440@UTC")).toBe("Every 1 day · UTC");
    expect(formatExpectation("cron:0 * * * *@Europe/Warsaw")).toBe(
      "Cron 0 * * * * · Europe/Warsaw",
    );
    expect(formatExpectation("event_driven:30@UTC")).toBe(
      "Event-driven · quiet window 30 minutes · UTC",
    );
  });

  it("formats timestamps in a readable local style with ISO preserved for tooltips", () => {
    expect(formatCatalogTimestamp("2026-07-29T20:16:00.000Z")).toBe(
      "29 Jul 2026, 20:16",
    );
    expect(formatCatalogTimestamp("2026-01-05T09:05:30.000Z")).toBe(
      "5 Jan 2026, 09:05",
    );

    const html = renderContractCard(baseRow());
    expect(html).toContain(">29 Jul 2026, 20:16</time>");
    expect(html).toContain('datetime="2026-07-29T20:16:00.000Z"');
    expect(html).toContain('title="2026-07-29T20:16:00.000Z"');
    expect(html).toContain(">29 Jul 2026, 20:17</time>");
    expect(html).not.toContain("Last execution: 2026-07-29T20:16:00.000Z");
  });

  it("keeps watcher and connector health inside collapsible technical details", () => {
    const pushHtml = renderContractCard(
      baseRow({
        monitoringMethod: "push",
        connectorHealth: null,
        watcherHealth: "ok",
      }),
    );
    expect(pushHtml).toContain('class="contract-technical"');
    expect(pushHtml).toContain("<summary>Technical details</summary>");
    expect(pushHtml).toContain("Watcher: ok");
    expect(pushHtml).toContain("Connector: Not applicable");
    expect(pushHtml).toContain("Monitoring: Push heartbeats");
    expect(pushHtml).toMatch(
      /contract-technical-body">[\s\S]*Watcher: ok[\s\S]*Connector: Not applicable/,
    );
    expect(pushHtml.indexOf("Technical details")).toBeLessThan(
      pushHtml.indexOf("Watcher: ok"),
    );

    const pollHtml = renderContractCard(
      baseRow({
        monitoringMethod: "poll",
        connectorHealth: "healthy",
        watcherHealth: "stale",
      }),
    );
    expect(pollHtml).toContain("Monitoring: Connect n8n (polling)");
    expect(pollHtml).toContain("Watcher: stale");
    expect(pollHtml).toContain("Connector: healthy");
    expect(pollHtml).toContain("Check heartbeat setup");
    expect(pollHtml).toContain("is-warning");
    expect(pollHtml).toContain(
      "Quorum has not received a new execution within the expected window.",
    );
    expect(pollHtml).toContain(
      "Early warning — an incident opens if this becomes Overdue.",
    );
    expect(pollHtml).toContain("Every 1 minute · UTC");
  });

  it("tints healthy cards slightly green", () => {
    const html = renderContractCard(
      baseRow({
        health: "healthy",
        displayHealth: "healthy",
        dimensions: {
          schedule: "healthy",
          output: "not_configured",
          freshness: "not_configured",
          reconciliation: "not_configured",
          monitor: "healthy",
          watchdog: "healthy",
        },
        overdueDurationSeconds: null,
        activeIncident: null,
      }),
    );
    expect(html).toContain("contract-card is-healthy");
    expect(html).not.toContain("is-warning");
    expect(html).not.toContain("is-overdue");
  });

  it("shows Failure reported instead of Overdue while hard_failure is open", () => {
    const html = renderContractCard(
      baseRow({
        health: "healthy",
        lastAcceptableEvidenceAt: "2026-07-29T19:00:00.000Z",
        lastReportAt: "2026-07-29T20:16:00.000Z",
        lastReportStatus: "failure",
        lastExternalExecutionRef: "n8n-exec-9",
        consecutiveFailures: 3,
        overdueDurationSeconds: null,
        activeIncident: {
          severity: "critical",
          summary: "Invoice sync: hard failure · 3 consecutive",
          id: "inc-hf",
          type: "hard_failure",
        },
      }),
    );
    expect(html).toContain("Failure reported");
    expect(html).toContain("Last report");
    expect(html).toContain("Last successful execution");
    expect(html).toContain("Consecutive failures: 3");
    expect(html).toContain("External execution ref: n8n-exec-9");
    expect(html).not.toContain(">Overdue<");
    expect(html).not.toContain("Quorum has not received a new execution");
  });

  it("shows Empty result / Contract violation without silence copy", () => {
    const warningHtml = renderContractCard(
      baseRow({
        health: "healthy",
        lastReportAt: "2026-07-29T20:16:00.000Z",
        lastReportStatus: "empty_result",
        lastItemsProcessed: 0,
        lastNonEmptySuccessAt: "2026-07-29T19:00:00.000Z",
        emptyResultPolicy: "warning",
        overdueDurationSeconds: null,
        activeIncident: {
          severity: "warning",
          summary: "Invoice sync: empty result",
          id: "inc-empty",
          type: "empty_result",
        },
      }),
    );
    expect(warningHtml).toContain("Empty result");
    expect(warningHtml).toContain("0 items");
    expect(warningHtml).toContain("Last non-empty success");
    expect(warningHtml).not.toContain("No recent execution");
    expect(warningHtml).not.toContain(
      "Quorum has not received a new execution",
    );

    const violationHtml = renderContractCard(
      baseRow({
        health: "healthy",
        lastReportAt: "2026-07-29T20:16:00.000Z",
        lastReportStatus: "empty_result",
        lastItemsProcessed: 0,
        lastNonEmptySuccessAt: "2026-07-29T19:00:00.000Z",
        emptyResultPolicy: "failure",
        overdueDurationSeconds: null,
        activeIncident: {
          severity: "critical",
          summary: "Invoice sync: contract violation",
          id: "inc-empty-2",
          type: "empty_result",
        },
      }),
    );
    expect(violationHtml).toContain("Contract violation");
  });
});
