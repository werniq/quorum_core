import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildN8nExecutionUrl } from "../../src/domain/n8n/workflow-editor-url.js";
import {
  renderIncidentsBody,
  type IncidentListRow,
} from "../../src/presentation/html/incidents-ui.js";

function incident(overrides: Partial<IncidentListRow> = {}): IncidentListRow {
  return {
    id: "inc-1",
    severity: "critical",
    status: "open",
    summary: "Two failed executions",
    openedAt: "2026-07-30T17:00:00.000Z",
    resolvedAt: null,
    lifecycleStatus: "active",
    acknowledgmentStatus: "unacknowledged",
    recoveredAt: null,
    recoveryEvidence: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgmentNote: null,
    detailsJson: JSON.stringify({
      consecutiveFailures: 2,
      externalExecutionRef: "9760",
    }),
    incidentType: "hard_failure",
    workflowId: "quorum-wf-1",
    workflowName: "Website Lead Synchronization",
    monitoringMethod: "poll",
    externalWorkflowId: "n8n-wf-9",
    connectorBaseUrl: "https://trusted-n8n.example",
    lastAcceptableEvidenceAt: null,
    nextExpectedAt: null,
    overdueSince: null,
    ...overrides,
  };
}

describe("incident traceability and history", () => {
  it("renders trusted Quorum, n8n workflow, and exact execution links", () => {
    const html = renderIncidentsBody({
      rows: [incident()],
      nowMs: Date.now(),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    expect(html).toContain('href="/catalog/contracts/quorum-wf-1"');
    expect(html).toContain(
      'href="https://trusted-n8n.example/workflow/n8n-wf-9"',
    );
    expect(html).toContain(
      'href="https://trusted-n8n.example/workflow/n8n-wf-9/executions/9760"',
    );
  });

  it("never treats an arbitrary execution reference as a URL", () => {
    expect(
      buildN8nExecutionUrl({
        baseUrl: "https://trusted-n8n.example",
        externalWorkflowId: "n8n-wf-9",
        externalExecutionRef: "https://attacker.example/execution/1",
      }),
    ).toBeNull();
    const html = renderIncidentsBody({
      rows: [
        incident({
          detailsJson: JSON.stringify({
            externalExecutionRef: "https://attacker.example/x",
          }),
        }),
      ],
      nowMs: Date.now(),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    expect(html).not.toContain('attacker.example/x"');
  });

  it("hides execution actions for legacy timestamp refs and invalid identifiers", () => {
    for (const row of [
      incident({
        detailsJson: JSON.stringify({
          externalExecutionRef: "n8n-1785994558556",
        }),
      }),
      incident({ externalWorkflowId: "bad workflow!" }),
      incident({
        detailsJson: JSON.stringify({ externalExecutionRef: "exec-42" }),
      }),
    ]) {
      const html = renderIncidentsBody({
        rows: [row],
        nowMs: Date.now(),
        csrf: "csrf",
        attentionCount: 0,
        warningCount: 0,
        overdueCount: 0,
      });
      expect(html).not.toContain("Inspect execution");
      expect(html).not.toContain("/executions/");
    }
  });

  it("separates review from acknowledged history and collapses evidence", () => {
    const review = incident({
      id: "review",
      lifecycleStatus: "recovered",
      recoveredAt: "2026-07-30T17:10:00.000Z",
    });
    const acknowledged = incident({
      id: "ack",
      lifecycleStatus: "recovered",
      acknowledgmentStatus: "acknowledged",
      recoveredAt: "2026-07-30T17:15:00.000Z",
      acknowledgedAt: "2026-07-30T17:16:00.000Z",
    });
    const html = renderIncidentsBody({
      rows: [review, acknowledged],
      nowMs: Date.now(),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    expect(html).toContain("Needs review");
    expect(html).toContain("Reviewed history");
    expect(html).toContain("Recovered · Needs review");
    expect(html).toContain("Recovered · Reviewed");
    expect(html).toContain(">Mark reviewed</button>");
    expect(html).toContain('class="incident-detail-panel"');
    expect(html).toContain(
      'class="incident-detail-panel" id="incident-panel-review" hidden',
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain(">Healthy</span>");
    expect(html).toContain("30 Jul 2026, 17:00");
    expect(html).toContain('title="2026-07-30T17:00:00.000Z"');
  });

  it("keeps only primary actions visible and groups expanded content", () => {
    const row = incident({
      lifecycleStatus: "recovered",
      recoveredAt: "2026-07-30T17:00:46.000Z",
    });
    const html = renderIncidentsBody({
      rows: [row],
      nowMs: Date.now(),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    const collapsed = html.slice(
      html.indexOf('<article class="incident-history-item'),
      html.indexOf('<div class="incident-detail-panel'),
    );
    expect(collapsed).toContain("View details");
    expect(collapsed).toContain("Inspect execution");
    expect(collapsed).toContain("Mark reviewed");
    expect(collapsed).not.toContain("View contract");
    expect(collapsed).not.toContain("View latest report");
    expect(html).toContain("Incident timeline");
    expect(html).toContain("Evidence");
    expect(html).toContain("Source");
    expect(html).toContain("Review");
    expect(html).toContain(
      "Recovered after a successful execution processed useful records.",
    );
    const card = html.slice(
      html.indexOf('<article class="incident-history-item'),
      html.indexOf("</article>") + "</article>".length,
    );
    expect(card.match(/Website Lead Synchronization/g)).toHaveLength(1);
  });

  it("uses a native keyboard button, ARIA state, and session-scoped expansion", () => {
    const html = renderIncidentsBody({
      rows: [
        incident({
          lifecycleStatus: "recovered",
          recoveredAt: "2026-07-30T17:01:00.000Z",
        }),
      ],
      nowMs: Date.now(),
      csrf: "csrf",
      attentionCount: 0,
      warningCount: 0,
      overdueCount: 0,
    });
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-controls="incident-panel-inc-1"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("sessionStorage.getItem");
    expect(html).toContain("sessionStorage.setItem");
    expect(html).toContain("button.addEventListener('click'");
    expect(html).not.toContain("localStorage");
  });

  it("shows Acknowledge for active unacknowledged and Mark reviewed for recovered", () => {
    const render = (row: IncidentListRow) =>
      renderIncidentsBody({
        rows: [row],
        nowMs: Date.now(),
        csrf: "csrf",
        attentionCount: 0,
        warningCount: 0,
        overdueCount: 0,
      });
    const activeHtml = render(incident());
    expect(activeHtml).toContain(">Acknowledge</button>");
    expect(activeHtml).toContain("Active");
    expect(activeHtml).not.toContain(">Mark reviewed</button>");

    const recoveredHtml = render(
      incident({
        lifecycleStatus: "recovered",
        recoveredAt: "2026-07-30T17:01:00.000Z",
      }),
    );
    expect(recoveredHtml).toContain(">Mark reviewed</button>");
    expect(recoveredHtml).not.toContain(">Acknowledge</button>");
    expect(recoveredHtml).toContain("Recovered · Needs review");

    const ackedActive = render(
      incident({
        acknowledgmentStatus: "acknowledged",
        acknowledgedAt: "2026-07-30T17:02:00.000Z",
        acknowledgedBy: "admin",
      }),
    );
    expect(ackedActive).toContain("Active · Acknowledged");
    expect(ackedActive).toContain("badge-status-incident");
    expect(ackedActive).not.toContain(">Acknowledge</button>");
    expect(ackedActive).not.toContain(">Mark reviewed</button>");
    expect(ackedActive).toContain('data-incident-section="active"');

    expect(
      render(
        incident({
          lifecycleStatus: "recovered",
          acknowledgmentStatus: "acknowledged",
          recoveredAt: "2026-07-30T17:01:00.000Z",
          acknowledgedAt: "2026-07-30T17:02:00.000Z",
        }),
      ),
    ).not.toContain(">Acknowledge</button>");
    expect(
      render(
        incident({
          lifecycleStatus: "recovered",
          acknowledgmentStatus: "acknowledged",
          recoveredAt: "2026-07-30T17:01:00.000Z",
          acknowledgedAt: "2026-07-30T17:02:00.000Z",
        }),
      ),
    ).not.toContain(">Mark reviewed</button>");
  });

  it("stacks detail metadata and actions at the mobile breakpoint", () => {
    const cssSource = fs.readFileSync(
      new URL("../../src/presentation/html/layout.ts", import.meta.url),
      "utf8",
    );
    expect(cssSource).toContain("@media (max-width: 768px)");
    expect(cssSource).toContain(
      ".incident-detail-grid { grid-template-columns:1fr; }",
    );
    expect(cssSource).toContain(
      ".incident-collapsed-actions button { width:100%; }",
    );
  });
});
