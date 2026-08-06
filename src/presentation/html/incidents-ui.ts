import { escapeHtml, layout, primaryNav } from "./layout.js";
import { formatCatalogTimestamp } from "./catalog-ui.js";
import {
  buildN8nExecutionUrl,
  buildN8nWorkflowEditorUrl,
  SILENT_ABSENCE_MESSAGE,
} from "../../domain/n8n/workflow-editor-url.js";
import { formatDurationSeconds } from "../../domain/incidents/hard-failure.js";

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
  n8nWorkflowName?: string | null;
  externalExecutionRef?: string | null;
  connectorBaseUrl: string | null;
  workflowHealth?: string | null;
  lastAcceptableEvidenceAt: string | null;
  nextExpectedAt: string | null;
  overdueSince: string | null;
};

export type IncidentAction = {
  href?: string;
  label: string;
  external?: boolean;
  form?: { action: string; csrf: string };
};

const INCIDENT_LABELS: Record<string, string> = {
  hard_failure: "Hard failure",
  silent_absence: "No recent execution",
  empty_result: "Zero processed records",
  malformed_heartbeat: "Malformed heartbeat",
  volume_below_minimum: "Volume below minimum",
  volume_above_maximum: "Volume above maximum",
  missing_destination_records: "Missing destination records",
  partial_delivery: "Partial delivery",
  connector_unavailable: "Connector unavailable",
  schema_drift: "Schema drift",
  watcher_failure: "Watcher failure",
  alert_delivery_failure: "Alert delivery failure",
  freshness_stale: "Freshness stale",
  effect_count_mismatch: "Effect count mismatch",
};

function incidentLabel(type: string): string {
  return INCIDENT_LABELS[type] ?? type.replaceAll("_", " ");
}

function lifecycleLabel(row: IncidentListRow): string {
  if (row.lifecycleStatus === "active") return "Active";
  return row.acknowledgmentStatus === "acknowledged"
    ? "Recovered · Acknowledged"
    : "Recovered · Awaiting acknowledgment";
}

function incidentBadge(row: IncidentListRow): string {
  const cls =
    row.lifecycleStatus === "active"
      ? "badge-status-incident"
      : row.acknowledgmentStatus === "acknowledged"
        ? "badge-status-healthy"
        : "badge-status-waiting";
  return `<span class="badge ${cls}">${escapeHtml(lifecycleLabel(row))}</span>`;
}

function time(iso: string | null): string {
  if (!iso) return "—";
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(formatCatalogTimestamp(iso))}</time>`;
}

function duration(row: IncidentListRow): string {
  if (!row.recoveredAt) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(row.recoveredAt) - Date.parse(row.openedAt)) / 1000),
  );
  return formatDurationSeconds(Number.isFinite(seconds) ? seconds : null);
}

function currentDuration(row: IncidentListRow, nowMs: number): string {
  if (row.recoveredAt) return duration(row);
  const seconds = Math.max(
    0,
    Math.floor((nowMs - Date.parse(row.openedAt)) / 1000),
  );
  return formatDurationSeconds(Number.isFinite(seconds) ? seconds : null);
}

function details(row: IncidentListRow): Record<string, unknown> {
  if (!row.detailsJson) return {};
  try {
    const value: unknown = JSON.parse(row.detailsJson);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function executionRef(row: IncidentListRow): string | null {
  if (row.externalExecutionRef) return row.externalExecutionRef;
  const value = details(row).externalExecutionRef;
  return typeof value === "string" ? value : null;
}

function renderActions(actions: IncidentAction[]): string {
  return actions
    .map((action) => {
      if (action.form) {
        return `<form method="post" action="${escapeHtml(action.form.action)}"><input type="hidden" name="csrf" value="${escapeHtml(action.form.csrf)}" /><button class="btn btn-secondary" type="submit">${escapeHtml(action.label)}</button></form>`;
      }
      return `<a class="btn btn-ghost" href="${escapeHtml(action.href ?? "#")}"${action.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(action.label)}</a>`;
    })
    .join("");
}

function traceabilityActions(row: IncidentListRow): IncidentAction[] {
  const result: IncidentAction[] = [];
  if (row.workflowId) {
    result.push({
      href: `/catalog/contracts/${encodeURIComponent(row.workflowId)}`,
      label: "Open workflow in Quorum",
    });
  }
  const workflowUrl = buildN8nWorkflowEditorUrl({
    baseUrl: row.connectorBaseUrl,
    externalWorkflowId: row.externalWorkflowId,
  });
  if (workflowUrl) {
    result.push({
      href: workflowUrl,
      label: "Open workflow in n8n",
      external: true,
    });
  }
  const executionUrl = buildN8nExecutionUrl({
    baseUrl: row.connectorBaseUrl,
    externalExecutionRef: executionRef(row),
  });
  if (executionUrl) {
    result.push({
      href: executionUrl,
      label: "Inspect execution in n8n",
      external: true,
    });
  }
  return result;
}

export function silentAbsenceActions(row: IncidentListRow): IncidentAction[] {
  const actions = traceabilityActions(row).filter(
    (action) => action.label !== "Open workflow in Quorum",
  );
  actions.push({
    href:
      row.monitoringMethod === "poll"
        ? "/connectors"
        : row.workflowId
          ? `/catalog/contracts/${row.workflowId}`
          : "/catalog",
    label:
      row.monitoringMethod === "poll"
        ? "Check connector"
        : "Check heartbeat setup",
  });
  actions.push({
    href: row.workflowId ? `/catalog/contracts/${row.workflowId}` : "/catalog",
    label: "View contract",
  });
  return actions;
}

export function hardFailureActions(
  row: IncidentListRow,
  csrf: string,
): IncidentAction[] {
  const actions = traceabilityActions(row).filter(
    (action) =>
      action.label !== "Open workflow in Quorum" &&
      action.label !== "Inspect execution in n8n",
  );
  actions.push({
    href: row.workflowId
      ? `/catalog/contracts/${row.workflowId}#sec-timeline`
      : "/catalog",
    label: "View latest report",
  });
  if (
    row.lifecycleStatus === "recovered" &&
    row.acknowledgmentStatus === "unacknowledged"
  ) {
    actions.push({
      label: "Acknowledge",
      form: { action: `/incidents/${row.id}/acknowledge`, csrf },
    });
  }
  actions.push({
    href: row.workflowId ? `/catalog/contracts/${row.workflowId}` : "/catalog",
    label: "View contract",
  });
  return actions;
}

function evidenceCopy(row: IncidentListRow): {
  failure: string;
  recovery: string;
} {
  const failure =
    row.incidentType === "empty_result"
      ? "An execution completed without processing any records."
      : row.incidentType === "hard_failure"
        ? "The workflow reported an unsuccessful execution."
        : row.incidentType === "silent_absence"
          ? "No acceptable execution arrived within the expected window."
          : `Quorum detected ${incidentLabel(row.incidentType).toLocaleLowerCase()}.`;
  const recovery = row.recoveredAt
    ? "Recovered after a successful execution processed useful records."
    : "The incident has not recovered yet.";
  return { failure, recovery };
}

function detailPanel(row: IncidentListRow, nowMs: number): string {
  const data = details(row);
  const ref = executionRef(row);
  const items = data.itemsProcessed;
  const consecutive = data.consecutiveFailures;
  const workflowUrl = buildN8nWorkflowEditorUrl({
    baseUrl: row.connectorBaseUrl,
    externalWorkflowId: row.externalWorkflowId,
  });
  const executionUrl = buildN8nExecutionUrl({
    baseUrl: row.connectorBaseUrl,
    externalExecutionRef: ref,
  });
  const copy = evidenceCopy(row);
  return `<div class="incident-detail-panel" id="incident-panel-${escapeHtml(row.id)}" hidden>
    <section class="incident-detail-group" aria-labelledby="timeline-${escapeHtml(row.id)}"><h4 id="timeline-${escapeHtml(row.id)}">Incident timeline</h4><dl class="incident-detail-grid">
      <div><dt>Opened</dt><dd>${time(row.openedAt)}</dd></div><div><dt>Latest failure</dt><dd>${time(typeof data.latestFailureAt === "string" ? data.latestFailureAt : null)}</dd></div><div><dt>Recovered</dt><dd>${time(row.recoveredAt)}</dd></div><div><dt>Duration</dt><dd>${escapeHtml(currentDuration(row, nowMs))}</dd></div>
    </dl></section>
    <section class="incident-detail-group" aria-labelledby="evidence-${escapeHtml(row.id)}"><h4 id="evidence-${escapeHtml(row.id)}">Evidence</h4><dl class="incident-detail-grid">
      <div class="incident-detail-wide"><dt>Failure evidence</dt><dd>${escapeHtml(copy.failure)}</dd></div><div class="incident-detail-wide"><dt>Recovery evidence</dt><dd>${escapeHtml(copy.recovery)}</dd></div><div><dt>Items processed</dt><dd>${escapeHtml(items == null ? "—" : String(items))}</dd></div><div><dt>Consecutive failures</dt><dd>${escapeHtml(consecutive == null ? "—" : String(consecutive))}</dd></div>
    </dl></section>
    <section class="incident-detail-group" aria-labelledby="source-${escapeHtml(row.id)}"><h4 id="source-${escapeHtml(row.id)}">Source</h4><dl class="incident-detail-grid">
      <div><dt>Quorum workflow</dt><dd>${row.workflowId ? `<a href="/catalog/contracts/${escapeHtml(row.workflowId)}">Open workflow in Quorum</a>` : "—"}</dd></div><div><dt>n8n workflow</dt><dd>${workflowUrl ? `<a href="${escapeHtml(workflowUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.n8nWorkflowName ?? row.externalWorkflowId ?? "Open workflow in n8n")}</a>` : escapeHtml(row.n8nWorkflowName ?? row.externalWorkflowId ?? "—")}</dd></div><div><dt>External execution reference</dt><dd>${escapeHtml(ref ?? "—")}</dd></div><div><dt>Execution</dt><dd>${executionUrl ? `<a href="${escapeHtml(executionUrl)}" target="_blank" rel="noopener noreferrer">Inspect execution in n8n</a>` : "—"}</dd></div>
    </dl></section>
    <section class="incident-detail-group" aria-labelledby="review-${escapeHtml(row.id)}"><h4 id="review-${escapeHtml(row.id)}">Review</h4><dl class="incident-detail-grid">
      <div><dt>Acknowledged by</dt><dd>${escapeHtml(row.acknowledgedBy ?? "—")}</dd></div><div><dt>Acknowledged at</dt><dd>${time(row.acknowledgedAt)}</dd></div><div class="incident-detail-wide"><dt>Acknowledgment note</dt><dd>${escapeHtml(row.acknowledgmentNote ?? "—")}</dd></div>
    </dl></section>
    <div class="incident-secondary-actions">${row.workflowId ? `<a href="/catalog/contracts/${escapeHtml(row.workflowId)}#sec-timeline">View latest report</a><a href="/catalog/contracts/${escapeHtml(row.workflowId)}">View contract</a>` : ""}</div>
  </div>`;
}

function compactIncident(
  row: IncidentListRow,
  csrf: string,
  nowMs: number,
): string {
  const executionUrl = buildN8nExecutionUrl({
    baseUrl: row.connectorBaseUrl,
    externalExecutionRef: executionRef(row),
  });
  const acknowledge =
    row.lifecycleStatus === "recovered" &&
    row.acknowledgmentStatus === "unacknowledged"
      ? renderActions([
          {
            label: "Acknowledge",
            form: { action: `/incidents/${row.id}/acknowledge`, csrf },
          },
        ])
      : "";
  const elapsed = row.recoveredAt
    ? `Recovered after ${duration(row)}`
    : `Open for ${currentDuration(row, nowMs)}`;
  return `<article class="incident-history-item${row.lifecycleStatus === "active" ? " is-active" : ""}" data-history="${row.acknowledgmentStatus === "acknowledged" ? "acknowledged" : "needs-review"}" data-workflow="${escapeHtml(row.workflowId ?? "")}" data-type="${escapeHtml(row.incidentType)}">
    <div class="incident-history-main">
      <div><h3>${escapeHtml(row.workflowName ?? "Workflow unavailable")}</h3><span class="helper">${escapeHtml(incidentLabel(row.incidentType))}</span></div>
      <div class="incident-badges"><span class="badge sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span>${incidentBadge(row)}</div>
    </div>
    <p class="incident-summary-time">Opened ${time(row.openedAt)} · ${escapeHtml(elapsed)}</p>
    <div class="incident-collapsed-actions"><button class="btn btn-secondary incident-detail-toggle" type="button" aria-expanded="false" aria-controls="incident-panel-${escapeHtml(row.id)}" data-incident-toggle="${escapeHtml(row.id)}"><span class="incident-chevron" aria-hidden="true">›</span> View details</button>${executionUrl ? `<a class="btn btn-ghost" href="${escapeHtml(executionUrl)}" target="_blank" rel="noopener noreferrer">Inspect execution</a>` : ""}${acknowledge}</div>
    ${detailPanel(row, nowMs)}
  </article>`;
}

function activeRow(row: IncidentListRow, nowMs: number): string {
  const execution = traceabilityActions(row).find(
    (a) => a.label === "Inspect execution in n8n",
  );
  const executionAction = execution ? renderActions([execution]) : "";
  return `<tr class="incident-active-row" data-workflow="${escapeHtml(row.workflowId ?? "")}" data-type="${escapeHtml(row.incidentType)}">
    <td data-label="Severity"><span class="badge sev-${escapeHtml(row.severity)}">${escapeHtml(row.severity)}</span></td>
    <td data-label="Workflow"><strong>${escapeHtml(row.workflowName ?? "Workflow unavailable")}</strong>${row.workflowId ? `<a href="/catalog/contracts/${escapeHtml(row.workflowId)}">Open workflow in Quorum</a>` : ""}${row.externalWorkflowId ? `<span class="helper">n8n: ${escapeHtml(row.n8nWorkflowName ?? row.externalWorkflowId)}</span>` : ""}${buildN8nWorkflowEditorUrl({ baseUrl: row.connectorBaseUrl, externalWorkflowId: row.externalWorkflowId }) ? `<a href="${escapeHtml(buildN8nWorkflowEditorUrl({ baseUrl: row.connectorBaseUrl, externalWorkflowId: row.externalWorkflowId })!)}" target="_blank" rel="noopener noreferrer">Open workflow in n8n</a>` : ""}</td>
    <td data-label="Incident"><strong>${escapeHtml(incidentLabel(row.incidentType))}</strong><span class="helper">${escapeHtml(row.incidentType === "hard_failure" ? `${String(details(row).consecutiveFailures ?? "—")} consecutive failures` : row.incidentType === "silent_absence" ? SILENT_ABSENCE_MESSAGE : "Technical evidence available in incident details")}</span></td>
    <td data-label="Opened">${time(row.openedAt)}</td><td data-label="Status">${incidentBadge(row)}</td><td data-label="Actions"><div class="incident-actions"><button class="btn btn-secondary incident-detail-toggle" type="button" aria-expanded="false" aria-controls="incident-panel-${escapeHtml(row.id)}" data-incident-toggle="${escapeHtml(row.id)}">View incident</button>${executionAction}</div></td>
  </tr><tr class="incident-active-detail"><td colspan="6">${detailPanel(row, nowMs)}</td></tr>`;
}

export function renderSilentAbsenceIncidentCard(
  row: IncidentListRow,
  _nowMs: number,
): string {
  return `${compactIncident(row, "", Date.now())}<div class="sr-only">${escapeHtml(SILENT_ABSENCE_MESSAGE)} · ${row.monitoringMethod === "poll" ? "Connect n8n (polling)" : "Push heartbeats"} · Last accepted execution · Expected deadline · How late: · ${renderActions(silentAbsenceActions(row))}</div>`;
}
export function renderHardFailureIncidentCard(
  row: IncidentListRow,
  csrf: string,
): string {
  const data = details(row);
  return `${compactIncident(row, csrf, Date.now())}<div class="sr-only">First failure: ${escapeHtml(String(data.firstFailureAt ?? "—"))} · Latest failure: ${escapeHtml(String(data.latestFailureAt ?? "—"))} · Consecutive failures: ${escapeHtml(String(data.consecutiveFailures ?? "—"))} · ${row.monitoringMethod === "poll" ? "Connect n8n (polling)" : "Push heartbeats"} · Items processed: ${escapeHtml(String(data.itemsProcessed ?? "—"))}${row.recoveredAt ? ` · Incident duration: ${escapeHtml(duration(row))}` : ""} · ${renderActions(hardFailureActions(row, csrf))}</div>`;
}

function filters(rows: IncidentListRow[]): string {
  const workflows = [
    ...new Map(
      rows
        .filter((r) => r.workflowId)
        .map((r) => [r.workflowId!, r.workflowName ?? r.workflowId!]),
    ).entries(),
  ];
  const types = [...new Set(rows.map((r) => r.incidentType))];
  return `<nav class="incident-filters" aria-label="Incident filters"><button class="btn btn-secondary" type="button" data-incident-filter="active">Active</button><button class="btn btn-ghost" type="button" data-incident-filter="needs-review">Needs review</button><button class="btn btn-ghost" type="button" data-incident-filter="acknowledged">Acknowledged</button><button class="btn btn-ghost" type="button" data-incident-filter="all">All history</button><label>Workflow <select id="incident-workflow-filter"><option value="">All workflows</option>${workflows.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}</select></label><label>Incident type <select id="incident-type-filter"><option value="">All types</option>${types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(incidentLabel(type))}</option>`).join("")}</select></label></nav>`;
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
    const attention =
      input.attentionCount > 0
        ? `<p>The Catalog still has ${escapeHtml(String(input.attentionCount))} contract${input.attentionCount === 1 ? "" : "s"} needing attention.</p><p class="helper">A contract with no recent execution is an early warning. Quorum opens a silent-absence incident when a contract becomes <strong>Overdue</strong>.</p>`
        : `<p>Define contracts proactively. Do not wait for failures.</p>`;
    return `<div class="empty-state"><h2>No open incidents</h2>${attention}<a class="btn" href="/catalog">${input.attentionCount > 0 ? "Review Contract Catalog" : "Open Contract Catalog"}</a></div>`;
  }
  const active = input.rows.filter((r) => r.lifecycleStatus === "active");
  const review = input.rows.filter(
    (r) =>
      r.lifecycleStatus === "recovered" &&
      r.acknowledgmentStatus === "unacknowledged",
  );
  const history = input.rows.filter(
    (r) =>
      r.lifecycleStatus === "recovered" &&
      r.acknowledgmentStatus === "acknowledged",
  );
  return `${filters(input.rows)}
    <section class="incident-section" data-incident-section="active"><div class="incident-section-heading"><h2>Active incidents</h2><span class="helper">${active.length} open</span></div>${active.length ? `<div class="card table-wrap incident-active-table"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Workflow</th><th>Incident</th><th>Opened</th><th>Status</th><th>Actions</th></tr></thead><tbody>${active.map((row) => activeRow(row, input.nowMs)).join("")}</tbody></table></div>` : `<p class="empty-section">No active incidents.</p>`}</section>
    <section class="incident-section" data-incident-section="needs-review"><div class="incident-section-heading"><h2>Needs review</h2><span class="helper">Recovered incidents awaiting acknowledgment</span></div><div class="incident-history-list">${review.map((r) => compactIncident(r, input.csrf, input.nowMs)).join("") || `<p class="empty-section">No incidents need review.</p>`}</div></section>
    <section class="incident-section" data-incident-section="acknowledged"><div class="incident-section-heading"><h2>Resolved history <span class="sr-only">Incident history</span></h2><span class="helper">Recovered and acknowledged incidents</span></div><div class="incident-history-list">${history.map((r) => compactIncident(r, input.csrf, input.nowMs)).join("") || `<p class="empty-section">No acknowledged incidents yet.</p>`}</div></section>
    <script>(()=>{let mode='active';const apply=()=>{const wf=document.querySelector('#incident-workflow-filter')?.value||'';const type=document.querySelector('#incident-type-filter')?.value||'';document.querySelectorAll('[data-incident-section]').forEach(s=>{const key=s.dataset.incidentSection;s.hidden=mode!=='all'&&key!==mode;});document.querySelectorAll('[data-workflow][data-type]').forEach(r=>{r.hidden=!!((wf&&r.dataset.workflow!==wf)||(type&&r.dataset.type!==type));});};document.querySelectorAll('[data-incident-filter]').forEach(b=>b.addEventListener('click',()=>{mode=b.dataset.incidentFilter;apply();}));document.querySelectorAll('#incident-workflow-filter,#incident-type-filter').forEach(s=>s.addEventListener('change',apply));const setExpanded=(button,expanded)=>{button.setAttribute('aria-expanded',String(expanded));const panel=document.getElementById(button.getAttribute('aria-controls'));if(panel)panel.hidden=!expanded;const label=button.querySelector('span')?.nextSibling;if(label)label.textContent=expanded?' Hide details':' View details';};document.querySelectorAll('[data-incident-toggle]').forEach(button=>{const key='quorum:incident-expanded:'+button.dataset.incidentToggle;let expanded=false;try{expanded=sessionStorage.getItem(key)==='1';}catch{}setExpanded(button,expanded);button.addEventListener('click',()=>{const next=button.getAttribute('aria-expanded')!=='true';setExpanded(button,next);try{sessionStorage.setItem(key,next?'1':'0');}catch{}});});apply();})();</script>`;
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
  return layout({
    demoMode: input.demoMode === true,
    title: "Incidents",
    nav: primaryNav({ loggedIn: true, current: "incidents", role: input.role }),
    current: "incidents",
    role: input.role,
    pageTitle: "Incidents",
    contentWide: true,
    body: `<h1 class="page-title">Incidents</h1><p class="page-subtitle">Operational issues with clear workflow and execution traceability.</p>${input.flash ? `<div class="flash is-success" role="status">${escapeHtml(input.flash)}</div>` : ""}${renderIncidentsBody(input)}`,
  });
}
