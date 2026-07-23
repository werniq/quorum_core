import {
  escapeHtml,
  evidenceBadge as evidenceLevelBadge,
  layout,
  primaryNav,
  renderStepper,
  statusBadge,
} from "./layout.js";
import type { CatalogBusinessSummary } from "../../domain/catalog/summary.js";
import { PROCESS_TEMPLATES } from "../../domain/catalog/process-templates.js";
import {
  evidenceRaiseConfidenceHint,
  plainUnverifiedLabels,
  plainVerifiedLabels,
} from "../../domain/catalog/evidence-explanation.js";

export type CatalogRowView = {
  contractId: string;
  workflowId: string | null;
  clientId: string | null;
  clientName: string | null;
  businessPurposeName: string;
  health: string;
  evidenceLevel: "basic" | "medium" | "high";
  evidenceExplanation: string;
  expectedCadenceOrWindow: string;
  lastAcceptableEvidenceAt: string | null;
  nextDeadlineAt: string | null;
  overdueDurationSeconds: number | null;
  alertChannelHealth: string;
  connectorHealth: string | null;
  activeIncident: { severity: string; summary: string } | null;
  contractKind: "workflow" | "outcome";
  sourceCount: number | null;
  destinationCount: number | null;
  missingCount: number | null;
  oldestMissingAgeSeconds: number | null;
  evidenceStale: boolean;
  isActive: boolean;
  verifiedDimensions: string[];
  unverifiedDimensions: string[];
  volumeSummary?: {
    label: string;
    expectedRange: string;
    currentCount: string;
    windowEndsLabel: string;
    status: string;
    unknownCountEvents: number;
    evidenceLevel: string;
  } | null;
};

function evidenceBadge(level: string, stale: boolean): string {
  const text =
    level === "high"
      ? "High — individual records reconciled"
      : level === "medium"
        ? "Medium — aggregate/destination check"
        : "Basic — destination not independently checked";
  return `${evidenceLevelBadge(level, stale)}
    <details class="evidence">
      <summary>${escapeHtml(text)}</summary>
      <p class="helper">${escapeHtml(evidenceRaiseConfidenceHint(level as "basic" | "medium" | "high"))}</p>
    </details>`;
}

function formatRelativeHint(iso: string | null, label: string): string {
  if (!iso) return `${label}: —`;
  return `${label}: ${iso}`;
}

export function formatExpectation(raw: string): string {
  const interval = raw.match(/^interval:(\d+)(?:@(.+))?$/i);
  if (interval) {
    const minutes = interval[1]!;
    const tz = interval[2] ? ` (${interval[2]})` : "";
    return `Every ${minutes} minutes${tz}`;
  }
  const cron = raw.match(/^cron:(.+)(?:@(.+))?$/i);
  if (cron) {
    const tz = cron[2] ? ` (${cron[2]})` : "";
    return `Cron ${cron[1]}${tz}`;
  }
  const eventDriven = raw.match(/^event_driven:(.+)(?:@(.+))?$/i);
  if (eventDriven) {
    const tz = eventDriven[2] ? ` (${eventDriven[2]})` : "";
    return `Event-driven · quiet window ${eventDriven[1]} min${tz}`;
  }
  return raw;
}

const ALERT_HEALTH_LABELS: Record<string, string> = {
  none: "No alert channel",
  healthy: "Alerts healthy",
  degraded: "Alert delivery degraded",
  failing: "Alert delivery failing",
  unknown: "Alert health unknown",
};

const HEALTH_FILTER_LABELS: Record<string, string> = {
  healthy: "Healthy",
  warning: "Waiting",
  overdue: "Overdue",
  unknown: "Unknown",
  inactive: "Paused",
};

const ALERT_FILTER_LABELS: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
  none: "No channel",
};

function alertHealthBadge(health: string): string {
  const label = ALERT_HEALTH_LABELS[health] ?? `Alerts: ${health}`;
  const cls =
    health === "failing"
      ? "badge-status-overdue"
      : health === "degraded"
        ? "badge-status-waiting"
        : health === "healthy"
          ? "badge-status-healthy"
          : health === "none"
            ? "badge-status-paused"
            : "badge-status-unknown";
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function contractPrimaryAction(row: CatalogRowView): {
  href: string;
  label: string;
} {
  const detail =
    row.contractKind === "outcome"
      ? `/catalog/outcome/${row.contractId}`
      : `/catalog/contracts/${row.workflowId}`;
  if (!row.isActive) {
    return { href: detail, label: "Review inactive contract" };
  }
  if (
    row.alertChannelHealth === "failing" ||
    row.alertChannelHealth === "degraded"
  ) {
    return { href: "/alerts", label: "Fix alert delivery" };
  }
  if (row.alertChannelHealth === "none") {
    return { href: "/alerts", label: "Assign alert channel" };
  }
  if (row.activeIncident) {
    return { href: detail, label: "Open incident" };
  }
  if (row.health === "overdue" || row.health === "warning") {
    return { href: detail, label: "Investigate" };
  }
  return { href: detail, label: "View contract" };
}

function renderContractCard(row: CatalogRowView): string {
  const detail =
    row.contractKind === "outcome"
      ? `/catalog/outcome/${row.contractId}`
      : `/catalog/contracts/${row.workflowId}`;
  const health = row.activeIncident
    ? `<span class="badge badge-status-incident"><span class="sr-only">Health: </span>Incident</span>`
    : statusBadge(row.health);
  const volume = row.volumeSummary
    ? `<div>Reported volume: ${escapeHtml(row.volumeSummary.currentCount)} (${escapeHtml(row.volumeSummary.status)})</div>`
    : "";
  const action = contractPrimaryAction(row);
  return `<article class="contract-card">
    <div class="contract-card-header">
      <div>
        <h3 class="contract-card-title"><a href="${escapeHtml(detail)}">${escapeHtml(row.businessPurposeName)}</a></h3>
        <div class="helper">${escapeHtml(row.clientName ?? "No client")} · ${escapeHtml(row.contractKind === "outcome" ? "Outcome" : "Workflow")}</div>
      </div>
      ${health}
    </div>
    <div class="contract-card-meta">
      <div>Expectation: ${escapeHtml(formatExpectation(row.expectedCadenceOrWindow))}</div>
      <div>${escapeHtml(formatRelativeHint(row.lastAcceptableEvidenceAt, "Last success"))}</div>
      <div>${escapeHtml(formatRelativeHint(row.nextDeadlineAt, "Next expected"))}</div>
      ${volume}
    </div>
    <div class="contract-card-footer">
      <div style="display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center">
        ${evidenceBadge(row.evidenceLevel, row.evidenceStale)}
        ${alertHealthBadge(row.alertChannelHealth)}
        ${
          row.activeIncident
            ? `<span class="badge badge-status-incident">${escapeHtml(row.activeIncident.summary)}</span>`
            : ""
        }
      </div>
      <a class="btn btn-secondary" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>
    </div>
  </article>`;
}

export function renderCatalogPage(input: {
  demoMode?: boolean;
  csrf: string;
  role: "admin" | "operator" | "viewer";
  contracts: CatalogRowView[];
  summary: CatalogBusinessSummary;
  clients: Array<{ id: string; name: string }>;
  filters: Record<string, string>;
  flash?: string | null;
  banner?: string | null;
}): string {
  const empty =
    input.contracts.length === 0
      ? `<div class="empty-state">
           <h2>No contracts yet</h2>
           <p>Define the first business process that should always work. Quorum protects explicit contracts, not generic monitors.</p>
           ${
             input.role !== "viewer"
               ? `<a class="btn" href="/protect">Protect a client</a>`
               : ""
           }
         </div>`
      : `<div class="contract-grid">${input.contracts.map(renderContractCard).join("")}</div>`;

  const s = input.summary;
  const filterVal = (key: string) => escapeHtml(input.filters[key] ?? "");

  return layout({
    demoMode: input.demoMode === true,
    title: "Contract Catalog",
    nav: primaryNav({ loggedIn: true, current: "catalog", role: input.role }),
    current: "catalog",
    role: input.role,
    pageTitle: "Contract Catalog",
    contentWide: true,
    flash: input.flash ?? null,
    banner: input.banner ?? null,
    body: `
      <h1 class="page-title">Contract Catalog</h1>
      <p class="page-subtitle">What should happen, is it happening, how sure are we, and what should I do?</p>
      <div class="summary-grid" aria-label="Catalog summary">
        <div class="card compact"><strong>${s.contractsCurrentlySatisfied}</strong><div class="helper">Contracts currently satisfied</div></div>
        <div class="card compact"><strong>${s.clientProcessesNeedingAttention}</strong><div class="helper">Processes needing attention</div></div>
        <div class="card compact"><strong>${s.outcomesMissingOrDelayed}</strong><div class="helper">Outcomes missing or delayed</div></div>
        <div class="card compact"><strong>${s.contractsWithOnlyBasicEvidence}</strong><div class="helper">Only basic evidence</div></div>
        <div class="card compact"><strong>${s.clientsWithFailingAlertDelivery}</strong><div class="helper">Contracts with failing alerts</div></div>
        <div class="card compact"><strong>${s.contractsNotYetActivated}</strong><div class="helper">Not yet activated</div></div>
      </div>
      <form class="card filters" method="get" action="/catalog" aria-label="Catalog filters">
        <label class="field">Client
          <select name="clientId">
            <option value="">All</option>
            ${input.clients
              .map(
                (c) =>
                  `<option value="${escapeHtml(c.id)}"${input.filters.clientId === c.id ? " selected" : ""}>${escapeHtml(c.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field">Health
          <select name="health">
            <option value="">All</option>
            ${["healthy", "warning", "overdue", "unknown", "inactive"]
              .map(
                (h) =>
                  `<option value="${h}"${input.filters.health === h ? " selected" : ""}>${HEALTH_FILTER_LABELS[h] ?? h}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field">Evidence
          <select name="evidenceLevel">
            <option value="">All</option>
            ${["basic", "medium", "high"]
              .map(
                (e) =>
                  `<option value="${e}"${input.filters.evidenceLevel === e ? " selected" : ""}>${e === "basic" ? "Basic" : e === "medium" ? "Medium" : "High"}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field">Type
          <select name="contractKind">
            <option value="">All</option>
            <option value="workflow"${input.filters.contractKind === "workflow" ? " selected" : ""}>Workflow</option>
            <option value="outcome"${input.filters.contractKind === "outcome" ? " selected" : ""}>Outcome</option>
          </select>
        </label>
        <label class="field">Alert health
          <select name="alertChannelHealth">
            <option value="">All</option>
            ${["healthy", "degraded", "failing", "unknown", "none"]
              .map(
                (a) =>
                  `<option value="${a}"${input.filters.alertChannelHealth === a ? " selected" : ""}>${ALERT_FILTER_LABELS[a] ?? a}</option>`,
              )
              .join("")}
          </select>
        </label>
        <button type="submit" class="btn-secondary">Apply filters</button>
      </form>
      ${empty}
      <input type="hidden" value="${escapeHtml(input.csrf)}" />
      <!-- filter debug ${filterVal("health")} -->
    `,
  });
}

const PROTECT_STEPS = [
  { id: "1", label: "Client" },
  { id: "2", label: "Process" },
  { id: "3", label: "Workflow" },
  { id: "4", label: "Contract" },
  { id: "5", label: "Alerts" },
  { id: "6", label: "Activate" },
];

const PROTECT_DRAFT_KEYS = [
  "clientId",
  "templateId",
  "businessPurpose",
  "cadenceValue",
  "workflowId",
  "workflowName",
  "externalWorkflowId",
  "monitoringMethod",
  "existingWorkflowId",
  "contractId",
  "channelId",
  "acknowledgedNoAlertMode",
] as const;

/** Back control associated via the HTML form= attribute (avoids nested forms). */
function protectBackControls(
  csrf: string,
  toStep: number,
  draft: Record<string, string>,
): { formHtml: string; buttonHtml: string } {
  const formId = `protect-back-${toStep}`;
  const fields = PROTECT_DRAFT_KEYS.map((key) => {
    const value = draft[key] ?? "";
    if (!value) {
      return "";
    }
    return `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`;
  }).join("");
  return {
    formHtml: `<form id="${escapeHtml(formId)}" method="post" action="/protect/back" hidden>
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
      <input type="hidden" name="to" value="${toStep}" />
      ${fields}
    </form>`,
    buttonHtml: `<button type="submit" form="${escapeHtml(formId)}" class="btn-secondary">Back</button>`,
  };
}

export function renderProtectClientPage(input: {
  demoMode?: boolean;
  csrf: string;
  step: number;
  clients: Array<{ id: string; name: string }>;
  workflows?: Array<{
    id: string;
    name: string;
    externalWorkflowId: string;
    monitoringMethod: string;
  }>;
  flash?: string | null;
  flashTone?: "error" | "success";
  draft?: Record<string, string>;
}): string {
  const d = input.draft ?? {};
  const stepId = String(Math.min(Math.max(input.step, 1), 6));
  const registeredWorkflows = input.workflows ?? [];
  const templates = PROCESS_TEMPLATES.map(
    (t) =>
      `<option value="${escapeHtml(t.id)}"${d.templateId === t.id ? " selected" : ""}>${escapeHtml(t.label)}</option>`,
  ).join("");

  let body = "";
  let backForms = "";
  if (input.step <= 1) {
    body = `
      <form method="post" action="/protect/client" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">Create or select a client</h2>
        <label class="field">Existing client
          <select name="clientId">
            <option value="">Create new…</option>
            ${input.clients
              .map(
                (c) =>
                  `<option value="${escapeHtml(c.id)}"${d.clientId === c.id ? " selected" : ""}>${escapeHtml(c.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field">New client name
          <input name="newClientName" placeholder="Acme Agency client" />
        </label>
        <div class="row-actions"><button type="submit">Continue</button></div>
      </form>`;
  } else if (input.step === 2) {
    const back = protectBackControls(input.csrf, 1, d);
    backForms = back.formHtml;
    body = `
      <form method="post" action="/protect/process" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <h2 class="card-title">Identify the critical process</h2>
        <p class="helper">Templates prefill questions. They do not activate a contract.</p>
        <label class="field">Template
          <select name="templateId" required>${templates}</select>
        </label>
        <label class="field">Business purpose
          <input name="businessPurpose" value="${escapeHtml(d.businessPurpose ?? "")}" required />
        </label>
        <div class="row-actions">${back.buttonHtml}<button type="submit">Continue</button></div>
      </form>`;
  } else if (input.step === 3) {
    const back = protectBackControls(input.csrf, 2, d);
    backForms = back.formHtml;
    const existingOptions =
      registeredWorkflows.length === 0
        ? ""
        : registeredWorkflows
            .map((w) => {
              const methodLabel =
                w.monitoringMethod === "poll" ? "Connect n8n" : "Push";
              return `<option value="${escapeHtml(w.id)}"${d.workflowId === w.id ? " selected" : ""}>${escapeHtml(w.name)} · n8n ${escapeHtml(w.externalWorkflowId)} · Quorum ${escapeHtml(w.id)} (${escapeHtml(methodLabel)})</option>`;
            })
            .join("");
    body = `
      <form method="post" action="/protect/workflow" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="templateId" value="${escapeHtml(d.templateId ?? "")}" />
        <input type="hidden" name="businessPurpose" value="${escapeHtml(d.businessPurpose ?? "")}" />
        <input type="hidden" name="cadenceValue" value="${escapeHtml(d.cadenceValue ?? "15")}" />
        <h2 class="card-title">Select a workflow</h2>
        <p class="helper">Use a workflow you already registered on the Workflows page, or register a new one here. The <strong>Quorum workflow ID</strong> (push signing / <code>QUORUM_WORKFLOW_ID</code>) is not the <strong>n8n workflow ID</strong> from the n8n URL.</p>
        ${
          registeredWorkflows.length > 0
            ? `<label class="field">Existing registered workflow
          <select name="existingWorkflowId">
            <option value="">Register new…</option>
            ${existingOptions}
          </select>
          <p class="helper">Selecting an existing workflow continues with its Quorum id. It does not create a duplicate.</p>
        </label>`
            : `<p class="helper">No workflows registered yet. Register one below, or <a href="/workflows">open Workflows</a> first.</p>`
        }
        <h3 class="section-title" style="margin-top:0.5rem">Register a new workflow</h3>
        <p class="helper">Only fill these fields when “Register new…” is selected above (or when you have none yet).</p>
        <label class="field">Workflow name
          <input name="workflowName" placeholder="Lead synchronization" value="${escapeHtml(d.workflowName ?? "")}" />
        </label>
        <label class="field">n8n workflow ID
          <input name="externalWorkflowId" placeholder="Enter the ID from your n8n workflow" value="${escapeHtml(d.externalWorkflowId ?? "")}" />
          <p class="helper">From the n8n URL: <code>http://localhost:5678/workflow/{workflow-id}</code>. This is the <strong>n8n workflow ID</strong>, not the Quorum workflow ID.</p>
        </label>
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Monitoring method</legend>
          <div class="radio-card-group" role="radiogroup" aria-label="Monitoring method">
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="poll"${d.monitoringMethod !== "push" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Connect n8n <span class="badge badge-rec">Easiest</span></span>
                <p class="radio-card-desc">URL + API key. No workflow changes or n8n env vars.</p>
              </span>
            </label>
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="push"${d.monitoringMethod === "push" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Push heartbeats</span>
                <p class="radio-card-desc">More detailed reporting. Edit one n8n setup node; HMAC secret in a Crypto credential when supported.</p>
              </span>
            </label>
          </div>
        </fieldset>
        <div class="row-actions">${back.buttonHtml}<button type="submit">Continue</button></div>
      </form>`;
  } else if (input.step === 4) {
    const back = protectBackControls(input.csrf, 3, d);
    backForms = back.formHtml;
    body = `
      <form method="post" action="/protect/contract" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="workflowId" value="${escapeHtml(d.workflowId ?? "")}" />
        <input type="hidden" name="businessPurpose" value="${escapeHtml(d.businessPurpose ?? "")}" />
        <h2 class="card-title">Define the contract</h2>
        <p class="helper">Suggested cadence is for review only. Confirmation is required before activation.</p>
        <label class="field">Contract name
          <input name="name" required value="${escapeHtml(d.businessPurpose ?? "")}" />
        </label>
        <label class="field">Cadence type
          <select name="cadenceType">
            <option value="interval">Interval</option>
            <option value="cron">Cron</option>
            <option value="event_driven">Event driven</option>
          </select>
        </label>
        <label class="field">Cadence value
          <input name="cadenceValue" required value="${escapeHtml(d.cadenceValue ?? "15")}" />
        </label>
        <label class="field">Timezone
          <input name="timezone" value="UTC" />
        </label>
        <label class="check-row">
          <input type="checkbox" name="explicitlyConfirmed" value="1" required />
          <span>I confirm this cadence or delivery window explicitly</span>
        </label>
        <label class="check-row">
          <input type="checkbox" name="evidenceAcknowledged" value="1" required />
          <span>I understand basic evidence does not prove destination delivery</span>
        </label>
        <div class="row-actions">${back.buttonHtml}<button type="submit">Continue</button></div>
      </form>`;
  } else if (input.step === 5) {
    const back = protectBackControls(input.csrf, 4, d);
    backForms = back.formHtml;
    const noAlertChecked = d.acknowledgedNoAlertMode === "1" ? " checked" : "";
    body = `
      <form method="post" action="/protect/alerts" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="workflowId" value="${escapeHtml(d.workflowId ?? "")}" />
        <input type="hidden" name="contractId" value="${escapeHtml(d.contractId ?? "")}" />
        <h2 class="card-title">Configure alerts</h2>
        <p class="helper">Optional for local try-outs. Monitoring status still appears on the <strong>Catalog</strong> dashboard either way. Without a channel, Catalog shows <strong>No alert channel</strong> and incidents are not delivered.</p>
        <label class="field">Channel name
          <input name="channelName" value="Ops webhook" />
        </label>
        <label class="field">Webhook URL
          <input name="url" placeholder="https://..." />
        </label>
        <label class="check-row">
          <input type="checkbox" name="acknowledgedNoAlertMode" value="1"${noAlertChecked} />
          <span>Skip alert delivery for now (local / self-hosted). Catalog will still show Waiting, Healthy, Overdue, and Incident — only outbound alerts are skipped.</span>
        </label>
        <div class="row-actions">${back.buttonHtml}<button type="submit">Continue</button></div>
      </form>`;
  } else {
    const back = protectBackControls(input.csrf, 5, d);
    backForms = back.formHtml;
    const noAlert = d.acknowledgedNoAlertMode === "1";
    body = `
      <form method="post" action="/protect/activate" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="workflowId" value="${escapeHtml(d.workflowId ?? "")}" />
        <input type="hidden" name="contractId" value="${escapeHtml(d.contractId ?? "")}" />
        <input type="hidden" name="channelId" value="${escapeHtml(d.channelId ?? "")}" />
        <input type="hidden" name="acknowledgedNoAlertMode" value="${noAlert ? "1" : ""}" />
        <h2 class="card-title">Activate monitoring</h2>
        <p class="helper">The first expected deadline appears after activation.${
          noAlert
            ? " You skipped alert delivery — Catalog will still show contract health, with <strong>No alert channel</strong>."
            : " Alert delivery uses the channel from the previous step."
        }</p>
        <label class="check-row">
          <input type="checkbox" name="explicitlyConfirmed" value="1" required />
          <span>Activate monitoring for this contract</span>
        </label>
        <div class="row-actions">${back.buttonHtml}<button type="submit">Activate monitoring</button></div>
      </form>`;
  }

  return layout({
    demoMode: input.demoMode === true,
    title: "Protect a client",
    nav: primaryNav({ loggedIn: true, current: "catalog", role: "admin" }),
    current: "catalog",
    flash: input.flash ?? null,
    flashTone: input.flashTone ?? "error",
    pageTitle: "Protect a client",
    body: `
      <h1 class="page-title">Protect a client</h1>
      <p class="page-subtitle">Connect a workflow and define what Quorum should expect.</p>
      ${renderStepper({ steps: PROTECT_STEPS, currentId: stepId })}
      <div class="wizard-panel">
      ${body}
      ${backForms}
      </div>
    `,
  });
}

export function renderClientsPage(input: {
  demoMode?: boolean;
  role: "admin" | "operator" | "viewer";
  clients: Array<{
    id: string;
    name: string;
    status: string;
    coverageNote: string;
  }>;
}): string {
  const rows = input.clients
    .map(
      (c) => `<tr>
        <td data-label="Client"><a href="/clients/${escapeHtml(c.id)}">${escapeHtml(c.name)}</a></td>
        <td data-label="Status">${escapeHtml(c.status)}</td>
        <td data-label="Coverage" class="helper">${escapeHtml(c.coverageNote)}</td>
      </tr>`,
    )
    .join("");
  return layout({
    demoMode: input.demoMode === true,
    title: "Clients",
    nav: primaryNav({ loggedIn: true, current: "clients", role: input.role }),
    current: "clients",
    role: input.role,
    pageTitle: "Clients",
    body: `
      <h1 class="page-title">Clients</h1>
      <p class="page-subtitle">Protection status does not mean every process is covered.</p>
      ${
        input.role !== "viewer"
          ? `<p style="margin-bottom:1.25rem"><a class="btn" href="/protect">Protect a client</a></p>`
          : ""
      }
      ${
        input.clients.length === 0
          ? `<div class="empty-state"><h2>No clients yet</h2><p>Define the first business process that should always work.</p></div>`
          : `<div class="card table-wrap" style="padding:0"><table class="responsive-cards">
        <thead><tr><th>Client</th><th>Status</th><th>Coverage</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
      }
    `,
  });
}

export function renderClientHealthPage(input: {
  demoMode?: boolean;

  role: "admin" | "operator" | "viewer";
  clientName: string;
  status: string;
  coverageNote: string;
  monitoringPeriod: string;
  contracts: CatalogRowView[];
}): string {
  const cards =
    input.contracts.length === 0
      ? `<div class="empty-state"><h2>No contracts for this client yet</h2><p>Protect a process to start monitoring.</p></div>`
      : `<div class="contract-grid">${input.contracts.map(renderContractCard).join("")}</div>`;
  return layout({
    demoMode: input.demoMode === true,
    title: `${input.clientName} health`,
    nav: primaryNav({ loggedIn: true, current: "clients", role: input.role }),
    current: "clients",
    role: input.role,
    pageTitle: input.clientName,
    body: `
      <h1 class="page-title">${escapeHtml(input.clientName)}</h1>
      <p class="page-subtitle">Status: <strong>${escapeHtml(input.status)}</strong> · ${escapeHtml(input.coverageNote)}</p>
      <p class="helper">Monitoring period: ${escapeHtml(input.monitoringPeriod)}</p>
      ${cards}
      <p class="helper">Raw credentials and internal logs are not shown on this client view.</p>
    `,
  });
}

function detailKv(label: string, value: string): string {
  return `<div class="detail-kv"><span class="detail-label">${escapeHtml(label)}</span><div class="detail-value">${escapeHtml(value)}</div></div>`;
}

function detailKvHtml(label: string, valueHtml: string): string {
  return `<div class="detail-kv"><span class="detail-label">${escapeHtml(label)}</span><div class="detail-value">${valueHtml}</div></div>`;
}

function detailKvFull(label: string, value: string): string {
  return `<div class="detail-kv detail-kv-full"><span class="detail-label">${escapeHtml(label)}</span><div class="detail-value">${escapeHtml(value)}</div></div>`;
}

function detailKvFullHtml(label: string, valueHtml: string): string {
  return `<div class="detail-kv detail-kv-full"><span class="detail-label">${escapeHtml(label)}</span><div class="detail-value">${valueHtml}</div></div>`;
}

function detailListItem(contentHtml: string): string {
  return `<li class="detail-list-item">${contentHtml}</li>`;
}

export function renderWorkflowContractDetailPage(input: {
  demoMode?: boolean;
  role: "admin" | "operator" | "viewer";
  csrf: string;
  contract: {
    name: string;
    businessPurpose: string;
    cadence: string;
    isActive: boolean;
    evidenceLevel: string;
    health: string;
    lastEvidence: string | null;
    nextDeadline: string | null;
    verified: string[];
    unverified: string[];
    raiseHint: string;
  };
  incidents: Array<{ summary: string; status: string; severity: string }>;
  channels: Array<{ name: string; health: string }>;
  recentEvents: Array<{ at: string; label: string }>;
  volume?: {
    label: string;
    expectedRange: string;
    currentCount: string;
    windowEndsLabel: string;
    status: string;
    unknownCountEvents: number;
    verified: string[];
    unverified: string[];
  } | null;
}): string {
  const c = input.contract;
  const activationBadge = c.isActive
    ? `<span class="badge badge-status-healthy">Active</span>`
    : `<span class="badge badge-status-paused">Inactive</span>`;
  const timelineItems = input.recentEvents.length
    ? input.recentEvents
        .map((e) =>
          detailListItem(
            `<time datetime="${escapeHtml(e.at)}">${escapeHtml(e.at)}</time><span>${escapeHtml(e.label)}</span>`,
          ),
        )
        .join("")
    : `<li class="detail-list-item helper">No meaningful transitions yet.</li>`;
  const incidentItems = input.incidents.length
    ? input.incidents
        .map((i) =>
          detailListItem(
            `<span class="sev-${escapeHtml(i.severity)}"><strong>${escapeHtml(i.summary)}</strong></span><span class="helper">${escapeHtml(i.status)}</span>`,
          ),
        )
        .join("")
    : `<li class="detail-list-item helper">No active incidents.</li>`;
  const channelItems = input.channels.length
    ? input.channels
        .map((ch) =>
          detailListItem(
            `<span>${escapeHtml(ch.name)}</span><span class="channel-${escapeHtml(ch.health)}">${escapeHtml(ch.health)}</span>`,
          ),
        )
        .join("")
    : `<li class="detail-list-item helper">No alert routes.</li>`;

  return layout({
    demoMode: input.demoMode === true,
    title: c.businessPurpose,
    nav: primaryNav({ loggedIn: true, current: "catalog", role: input.role }),
    current: "catalog",
    role: input.role,
    pageTitle: c.businessPurpose,
    body: `
      <div class="contract-detail">
      <h1 class="page-title">${escapeHtml(c.businessPurpose)}</h1>
      <p class="page-subtitle">${escapeHtml(c.name)} · ${escapeHtml(formatExpectation(c.cadence))}</p>
      <section class="card detail-section" aria-labelledby="sec-contract">
        <h2 class="section-title" id="sec-contract">Contract</h2>
        <div class="detail-kv-grid">
          ${detailKvHtml("Activation", activationBadge)}
          ${detailKvHtml("Health", `${statusBadge(c.health)} ${evidenceLevelBadge(c.evidenceLevel)}`)}
        </div>
      </section>
      <section class="card detail-section" aria-labelledby="sec-evidence">
        <h2 class="section-title" id="sec-evidence">Current evidence</h2>
        <div class="detail-kv-grid">
          ${detailKv("Last checked", c.lastEvidence ?? "never")}
          ${detailKv("Next deadline", c.nextDeadline ?? "—")}
          ${detailKvFull("Verified", c.verified.join("; ") || "none")}
          ${detailKvFull("Unverified", c.unverified.join("; ") || "none")}
        </div>
        <p class="helper detail-hint">${escapeHtml(c.raiseHint)}</p>
      </section>
      ${
        input.volume
          ? `<section class="card detail-section" aria-labelledby="sec-volume">
        <h2 class="section-title" id="sec-volume">${escapeHtml(input.volume.label)}</h2>
        <div class="detail-kv-grid">
          ${detailKv("Expected", input.volume.expectedRange)}
          ${detailKv("Current", input.volume.currentCount)}
          ${detailKv("Window ends", input.volume.windowEndsLabel)}
          ${detailKv("Status", input.volume.status)}
          ${detailKv("Unknown-count events", String(input.volume.unknownCountEvents))}
          ${detailKvFullHtml(
            "Evidence",
            `${evidenceLevelBadge("basic")} <span class="helper">Volume from heartbeat-reported counts</span>`,
          )}
          ${detailKvFull("Verified", input.volume.verified.join("; "))}
          ${detailKvFull("Not verified", input.volume.unverified.join("; "))}
        </div>
      </section>`
          : ""
      }
      <section class="card detail-section" aria-labelledby="sec-timeline">
        <h2 class="section-title" id="sec-timeline">Timeline</h2>
        <ul class="detail-list">${timelineItems}</ul>
      </section>
      <section class="card detail-section" aria-labelledby="sec-incident">
        <h2 class="section-title" id="sec-incident">Incidents</h2>
        <ul class="detail-list">${incidentItems}</ul>
      </section>
      <section class="card detail-section" aria-labelledby="sec-delivery">
        <h2 class="section-title" id="sec-delivery">Alert delivery</h2>
        <ul class="detail-list">${channelItems}</ul>
      </section>
      <section class="card detail-section" aria-labelledby="sec-tech">
        <h2 class="section-title" id="sec-tech">Technical details</h2>
        <p class="helper" style="margin:0">Raw heartbeat events and poll logs are available for debugging; they are not required to understand current health and evidence.</p>
      </section>
      <p class="detail-back"><a class="btn btn-secondary" href="/catalog">Back to catalog</a></p>
      </div>
    `,
  });
}

export function renderSimpleNavPage(input: {
  demoMode?: boolean;

  title: string;
  current: string;
  role: "admin" | "operator" | "viewer";
  body: string;
}): string {
  return layout({
    demoMode: input.demoMode === true,
    title: input.title,
    nav: primaryNav({
      loggedIn: true,
      current: input.current,
      role: input.role,
    }),
    current: input.current,
    role: input.role,
    pageTitle: input.title,
    body: input.body,
  });
}

export {
  plainVerifiedLabels,
  plainUnverifiedLabels,
  evidenceRaiseConfidenceHint,
};
