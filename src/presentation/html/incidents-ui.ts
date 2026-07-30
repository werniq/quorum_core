import {
  escapeHtml,
  layout,
  primaryNav,
  statusBadge,
} from "./layout.js";
import { formatCatalogTimestamp } from "./catalog-ui.js";
import {
  buildN8nWorkflowEditorUrl,
  SILENT_ABSENCE_MESSAGE,
} from "../../domain/n8n/workflow-editor-url.js";

export type IncidentListRow = {
  id: string;
  severity: string;
  status: string;
  summary: string;
  openedAt: string;
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
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function latenessSeconds(
  row: IncidentListRow,
  nowMs: number,
): number | null {
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

export function silentAbsenceActions(row: IncidentListRow): Array<{
  href: string;
  label: string;
  external?: boolean;
}> {
  const actions: Array<{ href: string; label: string; external?: boolean }> =
    [];
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
    // push (and unknown): heartbeat setup is the primary Quorum action
    actions.push({ href: contractHref, label: "Check heartbeat setup" });
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
  const actions = silentAbsenceActions(row)
    .map((action, index) => {
      const cls = index === 0 ? "btn btn-secondary" : "btn btn-ghost";
      const external = action.external
        ? ` target="_blank" rel="noopener noreferrer"`
        : "";
      return `<a class="${cls}" href="${escapeHtml(action.href)}"${external}>${escapeHtml(action.label)}</a>`;
    })
    .join("");

  return `<article class="contract-card is-overdue incident-card" data-incident-type="silent_absence">
    <div class="contract-card-header">
      <div>
        <h3 class="contract-card-title">${escapeHtml(row.workflowName ?? "Workflow")}</h3>
        <div class="helper">${escapeHtml(row.severity)} · ${escapeHtml(row.status)} · opened ${escapeHtml(formatCatalogTimestamp(row.openedAt))}</div>
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
      <div class="contract-card-actions">${actions}</div>
    </div>
  </article>`;
}

function renderGenericIncidentRow(row: IncidentListRow): string {
  return `<tr>
    <td data-label="Severity" class="sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</td>
    <td data-label="Status">${escapeHtml(row.status)}</td>
    <td data-label="Summary">${escapeHtml(row.summary)}</td>
    <td data-label="Opened" class="helper">${escapeHtml(row.openedAt)}</td>
  </tr>`;
}

export function renderIncidentsBody(input: {
  rows: IncidentListRow[];
  nowMs: number;
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

  const silent = input.rows.filter((r) => r.incidentType === "silent_absence");
  const other = input.rows.filter((r) => r.incidentType !== "silent_absence");

  const silentHtml =
    silent.length > 0
      ? `<div class="contract-grid">${silent
          .map((r) => renderSilentAbsenceIncidentCard(r, input.nowMs))
          .join("")}</div>`
      : "";

  const otherHtml =
    other.length > 0
      ? `<div class="card table-wrap" style="padding:0;margin-top:var(--space-4)"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th></tr></thead><tbody>${other
          .map(renderGenericIncidentRow)
          .join("")}</tbody></table></div>`
      : "";

  return `${silentHtml}${otherHtml}`;
}

export function renderIncidentsPage(input: {
  demoMode?: boolean;
  role: "admin" | "operator" | "viewer";
  rows: IncidentListRow[];
  nowMs: number;
  attentionCount: number;
  warningCount: number;
  overdueCount: number;
}): string {
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
      ${renderIncidentsBody(input)}
    `,
  });
}
