import { escapeHtml, layout, primaryNav, statusBadge } from "./layout.js";
import { formatCatalogTimestamp } from "./catalog-ui.js";
import {
  buildN8nWorkflowEditorUrl,
  SILENT_ABSENCE_MESSAGE,
} from "../../domain/n8n/workflow-editor-url.js";
import {
  formatDurationSeconds,
  parseHardFailureDetails,
  type HardFailureDetails,
} from "../../domain/incidents/hard-failure.js";

export type IncidentListRow = {
  id: string;
  severity: string;
  status: string;
  summary: string;
  openedAt: string;
  resolvedAt: string | null;
  lifecycleStatus: "active" | "recovered";
  acknowledgmentStatus: "unacknowledged" | "acknowledged";
  recoveredAt: string | null;
  recoveryEvidence: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgmentNote: string | null;
  detailsJson: string | null;
  incidentType: string;
  workflowId: string | null;
  workflowName: string | null;
  monitoringMethod: "poll" | "push" | null;
  externalWorkflowId: string | null;
  connectorBaseUrl: string | null;
  lastAcceptableEvidenceAt: string | null;
  nextExpectedAt: string | null;
  overdueSince: string | null;
};

function formatLateness(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "—";
  }
  return formatDurationSeconds(seconds);
}

function latenessSeconds(row: IncidentListRow, nowMs: number): number | null {
  const anchor = row.overdueSince ?? row.nextExpectedAt;
  if (!anchor) return null;
  const at = Date.parse(anchor);
  if (!Number.isFinite(at) || nowMs < at) return null;
  return Math.floor((nowMs - at) / 1000);
}

function formatTimestamp(iso: string | null, label: string): string {
  if (!iso) {
    return `${escapeHtml(label)}: —`;
  }
  const display = formatCatalogTimestamp(iso);
  return `${escapeHtml(label)}: <time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(display)}</time>`;
}

function monitoringLabel(method: "poll" | "push" | null): string {
  if (method === "poll") return "Connect n8n (polling)";
  if (method === "push") return "Push heartbeats";
  return "—";
}

type IncidentAction = {
  href?: string;
  label: string;
  external?: boolean;
  form?: { action: string; csrf: string };
};

function renderActions(actions: IncidentAction[]): string {
  return actions
    .map((action, index) => {
      const cls = index === 0 ? "btn btn-secondary" : "btn btn-ghost";
      if (action.form) {
        return `<form method="post" action="${escapeHtml(action.form.action)}" style="display:inline">
          <input type="hidden" name="csrf" value="${escapeHtml(action.form.csrf)}" />
          <button type="submit" class="${cls}">${escapeHtml(action.label)}</button>
        </form>`;
      }
      const external = action.external
        ? ` target="_blank" rel="noopener noreferrer"`
        : "";
      return `<a class="${cls}" href="${escapeHtml(action.href ?? "#")}"${external}>${escapeHtml(action.label)}</a>`;
    })
    .join("");
}

export function silentAbsenceActions(row: IncidentListRow): IncidentAction[] {
  const actions: IncidentAction[] = [];
  const n8nUrl = buildN8nWorkflowEditorUrl({
    baseUrl: row.connectorBaseUrl,
    externalWorkflowId: row.externalWorkflowId,
  });
  if (n8nUrl) {
    actions.push({
      href: n8nUrl,
      label: "Open workflow in n8n",
      external: true,
    });
  }

  const contractHref = row.workflowId
    ? `/catalog/contracts/${row.workflowId}`
    : "/catalog";

  if (row.monitoringMethod === "poll") {
    actions.push({ href: "/connectors", label: "Check connector" });
    actions.push({ href: contractHref, label: "View contract" });
  } else {
    actions.push({ href: contractHref, label: "Check heartbeat setup" });
    actions.push({ href: contractHref, label: "View contract" });
  }

  return actions;
}

export function hardFailureActions(
  row: IncidentListRow,
  csrf: string,
): IncidentAction[] {
  const actions: IncidentAction[] = [];
  const n8nUrl = buildN8nWorkflowEditorUrl({
    baseUrl: row.connectorBaseUrl,
    externalWorkflowId: row.externalWorkflowId,
  });
  if (n8nUrl) {
    actions.push({
      href: n8nUrl,
      label: "Open workflow in n8n",
      external: true,
    });
  }

  const contractHref = row.workflowId
    ? `/catalog/contracts/${row.workflowId}`
    : "/catalog";
  actions.push({
    href: `${contractHref}#sec-timeline`,
    label: "View latest report",
  });

  if (row.lifecycleStatus === "active") {
    actions.push({ href: contractHref, label: "View contract" });
  } else {
    if (row.acknowledgmentStatus === "unacknowledged") {
      actions.push({
        label: "Acknowledge",
        form: {
          action: `/incidents/${row.id}/acknowledge`,
          csrf,
        },
      });
    }
    actions.push({ href: contractHref, label: "View contract" });
  }

  return actions;
}

export function renderSilentAbsenceIncidentCard(
  row: IncidentListRow,
  nowMs: number,
): string {
  const contractHref = row.workflowId
    ? `/catalog/contracts/${row.workflowId}`
    : "/catalog";
  const late = formatLateness(latenessSeconds(row, nowMs));
  const displayStatus =
    row.lifecycleStatus === "active"
      ? "Active"
      : row.acknowledgmentStatus === "acknowledged"
        ? "Recovered · Acknowledged"
        : "Recovered · Awaiting acknowledgment";
  return `<article class="contract-card is-overdue incident-card" data-incident-type="silent_absence">
    <div class="contract-card-header">
      <div>
        <h3 class="contract-card-title">${escapeHtml(row.workflowName ?? "Workflow")}</h3>
        <div class="helper">${escapeHtml(row.severity)} · ${escapeHtml(displayStatus)} · opened ${escapeHtml(formatCatalogTimestamp(row.openedAt))}</div>
      </div>
      ${statusBadge("overdue")}
    </div>
    <p class="contract-card-message">${escapeHtml(SILENT_ABSENCE_MESSAGE)}</p>
    <div class="contract-card-meta">
      <div>Workflow: ${escapeHtml(row.workflowName ?? "—")}</div>
      <div>Monitoring: ${escapeHtml(monitoringLabel(row.monitoringMethod))}</div>
      <div>${formatTimestamp(row.lastAcceptableEvidenceAt, "Last accepted execution")}</div>
      <div>${formatTimestamp(row.nextExpectedAt, "Expected deadline")}</div>
      <div>How late: ${escapeHtml(late)}</div>
      <div>Contract: <a href="${escapeHtml(contractHref)}">Open in Quorum</a></div>
    </div>
    <div class="contract-card-footer">
      <div class="contract-card-actions">${renderActions(silentAbsenceActions(row))}</div>
    </div>
  </article>`;
}

function hardFailureMeta(
  row: IncidentListRow,
  details: HardFailureDetails | null,
): string {
  const method = monitoringLabel(
    details?.monitoringMethod ?? row.monitoringMethod,
  );
  const items =
    details?.itemsProcessed === null || details?.itemsProcessed === undefined
      ? "—"
      : String(details.itemsProcessed);
  const recovery =
    row.lifecycleStatus === "recovered" &&
    (row.recoveredAt || details?.recoveredAt)
      ? `<div>${formatTimestamp(details?.recoveredAt ?? row.recoveredAt, "Recovered")}</div>
      <div>Incident duration: ${escapeHtml(formatDurationSeconds(details?.durationSeconds ?? null))}</div>`
      : "";
  return `<div class="contract-card-meta">
      <div>Workflow: ${escapeHtml(details?.workflowName ?? row.workflowName ?? "—")}</div>
      <div>${formatTimestamp(details?.firstFailureAt ?? row.openedAt, "First failure")}</div>
      <div>${formatTimestamp(details?.latestFailureAt ?? null, "Latest failure")}</div>
      <div>Consecutive failures: ${escapeHtml(String(details?.consecutiveFailures ?? "—"))}</div>
      <div>Monitoring: ${escapeHtml(method)}</div>
      <div>Latest status: ${escapeHtml(details?.latestStatus ?? "failure")}</div>
      <div>Items processed: ${escapeHtml(items)}</div>
      <div>External execution ref: ${escapeHtml(details?.externalExecutionRef ?? "—")}</div>
      ${
        buildN8nWorkflowEditorUrl({
          baseUrl: row.connectorBaseUrl,
          externalWorkflowId: row.externalWorkflowId,
        })
          ? `<div>n8n workflow: <a href="${escapeHtml(
              buildN8nWorkflowEditorUrl({
                baseUrl: row.connectorBaseUrl,
                externalWorkflowId: row.externalWorkflowId,
              })!,
            )}" target="_blank" rel="noopener noreferrer">Open in n8n</a></div>`
          : ""
      }
      ${recovery}
      <div>Failure evidence: ${escapeHtml(row.summary)}</div>
      <div>Recovery evidence: ${escapeHtml(row.recoveryEvidence ?? "—")}</div>
      <div>Acknowledged by: ${escapeHtml(row.acknowledgedBy ?? "—")}</div>
      <div>${formatTimestamp(row.acknowledgedAt, "Acknowledged at")}</div>
      ${row.acknowledgmentNote ? `<div>Acknowledgment note: ${escapeHtml(row.acknowledgmentNote)}</div>` : ""}
    </div>`;
}

export function renderHardFailureIncidentCard(
  row: IncidentListRow,
  csrf: string,
): string {
  const details = parseHardFailureDetails(row.detailsJson);
  const tone =
    row.lifecycleStatus === "recovered" ? " is-healthy" : " is-overdue";
  const badge =
    row.lifecycleStatus === "recovered"
      ? statusBadge("healthy")
      : `<span class="badge badge-status-incident"><span class="sr-only">Health: </span>Hard failure</span>`;
  const message =
    row.lifecycleStatus === "recovered"
      ? escapeHtml(row.summary)
      : escapeHtml(
          details
            ? `${details.workflowName} reported a hard failure. Quorum is tracking consecutive failed executions until a successful heartbeat arrives.`
            : row.summary,
        );

  return `<article class="contract-card${tone} incident-card" data-incident-type="hard_failure">
    <div class="contract-card-header">
      <div>
        <h3 class="contract-card-title">${escapeHtml(details?.workflowName ?? row.workflowName ?? "Workflow")}</h3>
        <div class="helper">${escapeHtml(row.severity)} · ${row.lifecycleStatus === "active" ? "Active" : row.acknowledgmentStatus === "acknowledged" ? "Recovered · Acknowledged" : "Recovered · Awaiting acknowledgment"} · opened ${escapeHtml(formatCatalogTimestamp(row.openedAt))}</div>
      </div>
      ${badge}
    </div>
    <p class="contract-card-message">${message}</p>
    ${hardFailureMeta(row, details)}
    <div class="contract-card-footer">
      <div class="contract-card-actions">${renderActions(hardFailureActions(row, csrf))}</div>
    </div>
  </article>`;
}

function renderGenericIncidentRow(row: IncidentListRow, csrf: string): string {
  const displayStatus =
    row.lifecycleStatus === "active"
      ? "Active"
      : row.acknowledgmentStatus === "acknowledged"
        ? "Recovered · Acknowledged"
        : "Recovered · Awaiting acknowledgment";
  return `<tr>
    <td data-label="Severity" class="sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</td>
    <td data-label="Status">${escapeHtml(displayStatus)}</td>
    <td data-label="Summary">${escapeHtml(row.summary)}</td>
    <td data-label="Opened" class="helper">${escapeHtml(row.openedAt)}${row.lifecycleStatus === "recovered" ? `<br />Recovered: ${escapeHtml(row.recoveredAt ?? "—")}` : ""}</td>
    <td data-label="Review">${row.lifecycleStatus === "recovered" && row.acknowledgmentStatus === "unacknowledged" ? renderActions([{ label: "Acknowledge", form: { action: `/incidents/${row.id}/acknowledge`, csrf } }]) : "—"}</td>
  </tr>`;
}

export function renderIncidentsBody(input: {
  rows: IncidentListRow[];
  nowMs: number;
  csrf: string;
  attentionCount: number;
  warningCount: number;
  overdueCount: number;
}): string {
  if (input.rows.length === 0) {
    if (input.attentionCount > 0) {
      const detail =
        input.overdueCount > 0 && input.warningCount > 0
          ? `${input.warningCount} with no recent execution and ${input.overdueCount} overdue`
          : input.overdueCount > 0
            ? `${input.overdueCount} overdue`
            : `${input.warningCount} with no recent execution`;
      return `<div class="empty-state">
          <h2>No open incidents</h2>
          <p>The Catalog still has ${escapeHtml(String(input.attentionCount))} contract${input.attentionCount === 1 ? "" : "s"} needing attention (${escapeHtml(detail)}).</p>
          <p class="helper">“No recent execution” is an early warning. Quorum opens a silent-absence incident when a contract becomes <strong>Overdue</strong>.</p>
          <a class="btn" href="/catalog">Review Contract Catalog</a>
        </div>`;
    }
    return `<div class="empty-state"><h2>No open incidents</h2><p>Define contracts proactively. Do not wait for failures.</p><a class="btn" href="/catalog">Open Contract Catalog</a></div>`;
  }

  const isOpen = (r: IncidentListRow) => r.lifecycleStatus === "active";

  const openRows = input.rows.filter(isOpen);
  const recoveredNeedsReview = input.rows.filter(
    (r) =>
      r.lifecycleStatus === "recovered" &&
      r.acknowledgmentStatus === "unacknowledged",
  );
  const recoveredHistory = input.rows.filter(
    (r) =>
      r.lifecycleStatus === "recovered" &&
      r.acknowledgmentStatus === "acknowledged",
  );

  const silent = openRows.filter((r) => r.incidentType === "silent_absence");
  const hardOpen = openRows.filter((r) => r.incidentType === "hard_failure");
  const otherOpen = openRows.filter(
    (r) =>
      r.incidentType !== "silent_absence" && r.incidentType !== "hard_failure",
  );

  const openCards = [
    ...silent.map((r) => renderSilentAbsenceIncidentCard(r, input.nowMs)),
    ...hardOpen.map((r) => renderHardFailureIncidentCard(r, input.csrf)),
  ];

  const openCardsHtml =
    openCards.length > 0
      ? `<div class="contract-grid">${openCards.join("")}</div>`
      : "";

  const otherHtml =
    otherOpen.length > 0
      ? `<div class="card table-wrap" style="padding:0;margin-top:var(--space-4)"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th><th>Review</th></tr></thead><tbody>${otherOpen
          .map((row) => renderGenericIncidentRow(row, input.csrf))
          .join("")}</tbody></table></div>`
      : "";

  const needsReviewHtml =
    recoveredNeedsReview.length > 0
      ? `<section style="margin-top:var(--space-6)"><h2 class="section-title">Needs review</h2><p class="helper">Recovered incidents awaiting acknowledgment.</p><div class="contract-grid">${recoveredNeedsReview
          .filter((row) => row.incidentType === "hard_failure")
          .map((row) => renderHardFailureIncidentCard(row, input.csrf))
          .join("")}</div>${
          recoveredNeedsReview.some(
            (row) => row.incidentType !== "hard_failure",
          )
            ? `<div class="card table-wrap"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th><th>Review</th></tr></thead><tbody>${recoveredNeedsReview
                .filter((row) => row.incidentType !== "hard_failure")
                .map((row) => renderGenericIncidentRow(row, input.csrf))
                .join("")}</tbody></table></div>`
            : ""
        }</section>`
      : "";
  const historyHtml =
    recoveredHistory.length > 0
      ? `<section style="margin-top:var(--space-6)">
          <h2 class="section-title">Incident history</h2>
          <p class="helper">Recovered and acknowledged incidents remain available.</p>
          <div class="contract-grid">${recoveredHistory
            .filter((row) => row.incidentType === "hard_failure")
            .map((r) => renderHardFailureIncidentCard(r, input.csrf))
            .join("")}</div>
          ${
            recoveredHistory.some((row) => row.incidentType !== "hard_failure")
              ? `<div class="card table-wrap"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th><th>Review</th></tr></thead><tbody>${recoveredHistory
                  .filter((row) => row.incidentType !== "hard_failure")
                  .map((row) => renderGenericIncidentRow(row, input.csrf))
                  .join("")}</tbody></table></div>`
              : ""
          }
        </section>`
      : "";

  if (
    openCards.length === 0 &&
    otherOpen.length === 0 &&
    recoveredNeedsReview.length + recoveredHistory.length > 0
  ) {
    return `${needsReviewHtml}${historyHtml}`;
  }

  return `${openCardsHtml}${otherHtml}${needsReviewHtml}${historyHtml}`;
}

export function renderIncidentsPage(input: {
  demoMode?: boolean;
  role: "admin" | "operator" | "viewer";
  csrf: string;
  rows: IncidentListRow[];
  nowMs: number;
  attentionCount: number;
  warningCount: number;
  overdueCount: number;
  flash?: string | null;
}): string {
  const flash = input.flash
    ? `<div class="flash is-success" role="status">${escapeHtml(input.flash)}</div>`
    : "";
  return layout({
    demoMode: input.demoMode === true,
    title: "Incidents",
    nav: primaryNav({
      loggedIn: true,
      current: "incidents",
      role: input.role,
    }),
    current: "incidents",
    role: input.role,
    pageTitle: "Incidents",
    contentWide: true,
    body: `
      <h1 class="page-title">Incidents</h1>
      <p class="page-subtitle">Operational issues that need acknowledgement or resolution.</p>
      ${flash}
      ${renderIncidentsBody(input)}
    `,
  });
}
