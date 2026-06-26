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
import { unverifiedDimensionsForEvidenceLevel } from "../../domain/evidence/unverified-dimensions.js";

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

function formatExpectation(raw: string): string {
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
  if (row.alertChannelHealth === "failing" || row.alertChannelHealth === "degraded") {
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

export function renderProtectClientPage(input: {
  csrf: string;
  step: number;
  clients: Array<{ id: string; name: string }>;
  flash?: string | null;
  flashTone?: "error" | "success";
  draft?: Record<string, string>;
}): string {
  const d = input.draft ?? {};
  const stepId = String(Math.min(Math.max(input.step, 1), 6));
  const templates = PROCESS_TEMPLATES.map(
    (t) =>
      `<option value="${escapeHtml(t.id)}"${d.templateId === t.id ? " selected" : ""}>${escapeHtml(t.label)}</option>`,
  ).join("");

  let body = "";
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
                  `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="field">New client name
          <input name="newClientName" placeholder="Acme Agency client" />
        </label>
        <div class="row-actions"><button type="submit">Save client</button></div>
      </form>`;
  } else if (input.step === 2) {
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
        <div class="row-actions"><button type="submit">Save process</button></div>
      </form>`;
  } else if (input.step === 3) {
    body = `
      <form method="post" action="/protect/workflow" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="templateId" value="${escapeHtml(d.templateId ?? "")}" />
        <input type="hidden" name="businessPurpose" value="${escapeHtml(d.businessPurpose ?? "")}" />
        <h2 class="card-title">Select a workflow</h2>
        <p class="helper">Register an n8n workflow before defining its monitoring contract.</p>
        <label class="field">Workflow name
          <input name="workflowName" required placeholder="Lead synchronization" value="${escapeHtml(d.workflowName ?? "")}" />
        </label>
        <label class="field">n8n workflow ID
          <input name="externalWorkflowId" required placeholder="Enter the ID from your n8n workflow" value="${escapeHtml(d.externalWorkflowId ?? "")}" />
          <p class="helper">Find it in the n8n workflow URL: <code>http://localhost:5678/workflow/{workflow-id}</code></p>
        </label>
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Monitoring method</legend>
          <div class="radio-card-group" role="radiogroup" aria-label="Monitoring method">
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="push"${d.monitoringMethod !== "poll" ? " checked" : ""} required />
              <span>
                <span class="radio-card-title">Push heartbeats <span class="badge badge-rec">Recommended</span></span>
                <p class="radio-card-desc">Best for precise status, item counts, failures, and immediate reporting.</p>
              </span>
            </label>
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="poll"${d.monitoringMethod === "poll" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Connect n8n</span>
                <p class="radio-card-desc">Quorum reads workflow executions through the n8n API.</p>
              </span>
            </label>
          </div>
        </fieldset>
        <div class="row-actions"><button type="submit">Register workflow</button></div>
      </form>`;
  } else if (input.step === 4) {
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
        <div class="row-actions"><button type="submit">Save inactive contract</button></div>
      </form>`;
  } else if (input.step === 5) {
    body = `
      <form method="post" action="/protect/alerts" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="workflowId" value="${escapeHtml(d.workflowId ?? "")}" />
        <input type="hidden" name="contractId" value="${escapeHtml(d.contractId ?? "")}" />
        <h2 class="card-title">Configure alerts</h2>
        <label class="field">Channel name
          <input name="channelName" value="Ops webhook" required />
        </label>
        <label class="field">Webhook URL
          <input name="url" required placeholder="https://..." />
        </label>
        <div class="row-actions"><button type="submit">Create and test channel</button></div>
      </form>`;
  } else {
    body = `
      <form method="post" action="/protect/activate" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="clientId" value="${escapeHtml(d.clientId ?? "")}" />
        <input type="hidden" name="workflowId" value="${escapeHtml(d.workflowId ?? "")}" />
        <input type="hidden" name="contractId" value="${escapeHtml(d.contractId ?? "")}" />
        <input type="hidden" name="channelId" value="${escapeHtml(d.channelId ?? "")}" />
        <h2 class="card-title">Activate monitoring</h2>
        <p class="helper">The first expected deadline appears after activation. An alert route must be tested unless you acknowledge no-alert local mode.</p>
        <label class="check-row">
          <input type="checkbox" name="explicitlyConfirmed" value="1" required />
          <span>Activate monitoring for this contract</span>
        </label>
        <label class="check-row">
          <input type="checkbox" name="acknowledgedNoAlertMode" value="1" />
          <span>Self-hosted local development: acknowledge no-alert mode</span>
        </label>
        <div class="row-actions"><button type="submit">Activate monitoring</button></div>
      </form>`;
  }

  return layout({
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
      ${body}
    `,
  });
}

export function renderClientsPage(input: {
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

export function renderWorkflowContractDetailPage(input: {
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
  return layout({
    title: c.businessPurpose,
    nav: primaryNav({ loggedIn: true, current: "catalog", role: input.role }),
    current: "catalog",
    role: input.role,
    pageTitle: c.businessPurpose,
    body: `
      <h1 class="page-title">${escapeHtml(c.businessPurpose)}</h1>
      <p class="page-subtitle">${escapeHtml(c.name)} · ${escapeHtml(c.cadence)}</p>
      <section class="card stack" aria-labelledby="sec-contract">
        <h2 class="section-title" id="sec-contract">Contract</h2>
        <p>Activation: ${
          c.isActive
            ? `<span class="badge badge-status-healthy">Active</span>`
            : `<span class="badge badge-status-paused">Inactive</span>`
        }</p>
        <p>${statusBadge(c.health)} ${evidenceLevelBadge(c.evidenceLevel)}</p>
      </section>
      <section class="card stack" aria-labelledby="sec-evidence">
        <h2 class="section-title" id="sec-evidence">Current evidence</h2>
        <p>Last checked: ${escapeHtml(c.lastEvidence ?? "never")}</p>
        <p>Next deadline: ${escapeHtml(c.nextDeadline ?? "—")}</p>
        <p><strong>Verified:</strong> ${escapeHtml(c.verified.join("; ") || "none")}</p>
        <p><strong>Unverified:</strong> ${escapeHtml(c.unverified.join("; ") || "none")}</p>
        <p class="helper">${escapeHtml(c.raiseHint)}</p>
      </section>
      ${
        input.volume
          ? `<section class="card stack" aria-labelledby="sec-volume">
        <h2 class="section-title" id="sec-volume">${escapeHtml(input.volume.label)}</h2>
        <p>Expected: ${escapeHtml(input.volume.expectedRange)}</p>
        <p>Current: ${escapeHtml(input.volume.currentCount)}</p>
        <p>Window ends: ${escapeHtml(input.volume.windowEndsLabel)}</p>
        <p>Status: ${escapeHtml(input.volume.status)}</p>
        <p>Unknown-count events: ${input.volume.unknownCountEvents}</p>
        <p>${evidenceLevelBadge("basic")} Volume from heartbeat-reported counts</p>
        <p><strong>Verified:</strong> ${escapeHtml(input.volume.verified.join("; "))}</p>
        <p><strong>Not verified:</strong> ${escapeHtml(input.volume.unverified.join("; "))}</p>
      </section>`
          : ""
      }
      <section class="card stack" aria-labelledby="sec-timeline">
        <h2 class="section-title" id="sec-timeline">Timeline</h2>
        <ul class="stack-sm" style="list-style:none;padding:0;margin:0">${
          input.recentEvents.length
            ? input.recentEvents
                .map(
                  (e) =>
                    `<li><time datetime="${escapeHtml(e.at)}">${escapeHtml(e.at)}</time> · ${escapeHtml(e.label)}</li>`,
                )
                .join("")
            : '<li class="helper">No meaningful transitions yet.</li>'
        }</ul>
      </section>
      <section class="card stack" aria-labelledby="sec-incident">
        <h2 class="section-title" id="sec-incident">Incidents</h2>
        ${
          input.incidents.length
            ? input.incidents
                .map(
                  (i) =>
                    `<p class="sev-${escapeHtml(i.severity)}"><strong>${escapeHtml(i.summary)}</strong> · ${escapeHtml(i.status)}</p>`,
                )
                .join("")
            : `<p class="helper">No active incidents.</p>`
        }
      </section>
      <section class="card stack" aria-labelledby="sec-delivery">
        <h2 class="section-title" id="sec-delivery">Alert delivery</h2>
        ${
          input.channels.length
            ? input.channels
                .map(
                  (ch) =>
                    `<p>${escapeHtml(ch.name)} · <span class="channel-${escapeHtml(ch.health)}">${escapeHtml(ch.health)}</span></p>`,
                )
                .join("")
            : `<p class="helper">No alert routes.</p>`
        }
      </section>
      <section class="card stack" aria-labelledby="sec-tech">
        <h2 class="section-title" id="sec-tech">Technical details</h2>
        <p class="helper">Raw heartbeat events and poll logs are available for debugging; they are not required to understand current health and evidence.</p>
      </section>
      <p><a class="btn btn-secondary" href="/catalog">Back to catalog</a></p>
    `,
  });
}

export function renderSimpleNavPage(input: {
  title: string;
  current: string;
  role: "admin" | "operator" | "viewer";
  body: string;
}): string {
  return layout({
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
