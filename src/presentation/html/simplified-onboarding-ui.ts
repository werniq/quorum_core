import { escapeHtml, layout, primaryNav, renderStepper } from "./layout.js";
import type { OnboardingStep } from "../../infrastructure/db/repositories/sqlite-onboarding-repositories.js";
import type { OnboardingDraft } from "../../domain/onboarding/draft.js";
import { selectedWorkflowConfigs } from "../../domain/onboarding/draft.js";
import type { DiscoveredWorkflow } from "../../domain/n8n/discovered-workflow.js";

const FLOW: Array<{ id: OnboardingStep; label: string }> = [
  { id: "client", label: "Client" },
  { id: "connect_n8n", label: "Connect n8n" },
  { id: "select_workflows", label: "Select workflows" },
  { id: "configure_monitoring", label: "Monitoring" },
  { id: "alerts_activate", label: "Alerts" },
];

function backButton(csrf: string, to: OnboardingStep): string {
  return `<form method="post" action="/onboarding/back" class="wizard-back-bar">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
    <input type="hidden" name="to" value="${escapeHtml(to)}" />
    <button type="submit" class="btn-secondary">Back</button>
  </form>`;
}

export interface SimplifiedOnboardingPageInput {
  demoMode?: boolean;
  csrf: string;
  step: OnboardingStep;
  draft: OnboardingDraft;
  flash?: string | null;
  flashTone?: "error" | "success";
  clients: Array<{ id: string; name: string }>;
  connectors: Array<{ id: string; name: string; baseUrl: string }>;
  alertChannels: Array<{ id: string; name: string; health: string }>;
  discovered?: DiscoveredWorkflow[];
  discoveryError?: string | null;
  protectedExternalIds?: Set<string>;
  completionRows?: Array<{
    name: string;
    monitoringMode: string;
    alertRules: string[];
    timingLabel: string;
    outcomeThreshold: string | null;
    heartbeatAccepted: boolean;
    statusLabel: string;
    connected: boolean;
    discovered: boolean;
    monitoring: boolean;
    alertTested: boolean | null;
    waitingFirst: boolean;
  }>;
  outcomeSetups?: Array<{
    workflowName: string;
    workflowId: string;
    keyId: string;
    secret: string;
    ingestPath: string;
  }>;
}

export function renderSimplifiedOnboardingPage(
  input: SimplifiedOnboardingPageInput,
): string {
  const stepForStepper =
    input.step === "complete" || input.step === "catalog"
      ? "alerts_activate"
      : FLOW.some((s) => s.id === input.step)
        ? input.step
        : "client";
  const stepper = renderStepper({
    steps: FLOW,
    currentId: stepForStepper,
  });

  let body = "";
  if (input.step === "client") {
    body = renderClientStep(input);
  } else if (input.step === "connect_n8n") {
    body = renderConnectStep(input);
  } else if (input.step === "select_workflows") {
    body = renderSelectStep(input);
  } else if (input.step === "configure_monitoring") {
    body = renderConfigureStep(input);
  } else if (input.step === "alerts_activate") {
    body = renderAlertsStep(input);
  } else if (input.step === "complete") {
    body = renderCompleteStep(input);
  } else {
    body = renderClientStep(input);
  }

  return layout({
    demoMode: input.demoMode === true,
    title: "Set up monitoring",
    nav: primaryNav({ loggedIn: true, role: "admin", current: "onboarding" }),
    current: "onboarding",
    pageTitle: "Set up monitoring",
    flash: input.flash ?? null,
    flashTone: input.flashTone ?? "error",
    body: `${stepper}${body}`,
  });
}

function renderClientStep(input: SimplifiedOnboardingPageInput): string {
  const options = input.clients
    .map(
      (c) =>
        `<label class="radio-card">
          <input type="radio" name="clientId" value="${escapeHtml(c.id)}"${input.draft.clientId === c.id ? " checked" : ""} />
          <span><span class="radio-card-title">${escapeHtml(c.name)}</span>
          <p class="radio-card-desc">Existing client</p></span>
        </label>`,
    )
    .join("");
  return `
    <form method="post" action="/onboarding/client" class="card stack">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <h2 class="card-title">Who are these workflows for?</h2>
      <p class="helper">Select an existing client or create a new one. A client is the business whose workflows you are protecting.</p>
      <div class="radio-card-group" role="radiogroup" aria-label="Client">
        ${options}
        <label class="radio-card">
          <input type="radio" name="clientId" value=""${!input.draft.clientId ? " checked" : ""} />
          <span><span class="radio-card-title">Create a new client</span>
          <p class="radio-card-desc">Enter a name below</p></span>
        </label>
      </div>
      <label class="field">
        <span class="field-label">New client name</span>
        <input name="newClientName" placeholder="Acme Corp" value="${escapeHtml(input.draft.clientName ?? "")}" />
      </label>
      <div class="row-actions"><button type="submit">Continue</button></div>
    </form>`;
}

function renderConnectStep(input: SimplifiedOnboardingPageInput): string {
  const existing = input.connectors
    .map(
      (c) =>
        `<label class="radio-card">
          <input type="radio" name="connectorId" value="${escapeHtml(c.id)}"${input.draft.connectorId === c.id ? " checked" : ""} />
          <span><span class="radio-card-title">${escapeHtml(c.name)}</span>
          <p class="radio-card-desc">${escapeHtml(c.baseUrl)}</p></span>
        </label>`,
    )
    .join("");
  const success =
    input.draft.connectionTestOk === true
      ? `<div class="flash is-success" role="status">
          <strong>Connected to n8n</strong>
          <p>Authentication succeeded.${
            input.draft.workflowCountHint != null
              ? ` ${escapeHtml(String(input.draft.workflowCountHint))} workflow(s) are available on the first page.`
              : " Workflows are available."
          }</p>
        </div>`
      : "";
  return `
    ${backButton(input.csrf, "client")}
    ${success}
    <form method="post" action="/onboarding/connect/select" class="card stack" style="margin-bottom:1rem">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <h2 class="card-title">Reuse an n8n connection</h2>
      <p class="helper">Pick an existing connection if Quorum already talks to this n8n.</p>
      <div class="radio-card-group">${existing || "<p class='helper'>No saved connections yet.</p>"}</div>
      <div class="row-actions"><button type="submit" class="btn-secondary" ${input.connectors.length === 0 ? "disabled" : ""}>Use selected connection</button></div>
    </form>
    <form method="post" action="/onboarding/connect" class="card stack">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <h2 class="card-title">Connect n8n</h2>
      <p class="helper">Quorum uses your n8n URL and API key to discover workflows. The API key is stored encrypted and is never shown again.</p>
      <label class="field">
        <span class="field-label">n8n URL</span>
        <input name="baseUrl" required placeholder="http://host.docker.internal:5678" />
      </label>
      <label class="field">
        <span class="field-label">n8n API key</span>
        <input name="apiKey" type="password" required autocomplete="off" />
      </label>
      <label class="field">
        <span class="field-label">Connection name</span>
        <input name="name" placeholder="Production n8n" value="n8n" />
      </label>
      <div class="row-actions"><button type="submit">Test connection</button></div>
    </form>`;
}

function renderSelectStep(input: SimplifiedOnboardingPageInput): string {
  const protectedIds = input.protectedExternalIds ?? new Set<string>();
  const selected = new Set(
    (input.draft.selectedExternalWorkflowIds ?? []).filter(
      (id) => !protectedIds.has(id),
    ),
  );
  const q = (input.draft.search ?? "").trim().toLowerCase();
  const rows = (input.discovered ?? [])
    .filter((w) => !q || w.name.toLowerCase().includes(q))
    .map((w) => {
      const already = protectedIds.has(w.externalWorkflowId);
      const state = w.active ? "Active" : "Inactive";
      if (already) {
        return `<div class="radio-card is-protected" aria-disabled="true" style="align-items:flex-start">
          <span class="protected-status-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" focusable="false"><path fill="currentColor" d="M4.5 6V4.5a3.5 3.5 0 0 1 7 0V6h.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h.5Zm1.5 0h4V4.5a2 2 0 1 0-4 0V6Z"/></svg>
          </span>
          <span>
            <span class="radio-card-title">${escapeHtml(w.name)} <span class="badge badge-status-unknown">Already protected</span></span>
            <p class="radio-card-desc">${escapeHtml(state)} · ${escapeHtml(w.triggerSummary)}</p>
          </span>
        </div>`;
      }
      return `<label class="radio-card" style="align-items:flex-start">
        <input type="checkbox" name="externalWorkflowIds" value="${escapeHtml(w.externalWorkflowId)}"${selected.has(w.externalWorkflowId) ? " checked" : ""} />
        <span>
          <span class="radio-card-title">${escapeHtml(w.name)}</span>
          <p class="radio-card-desc">${escapeHtml(state)} · ${escapeHtml(w.triggerSummary)}</p>
        </span>
      </label>`;
    })
    .join("");

  return `
    ${backButton(input.csrf, "connect_n8n")}
    ${input.discoveryError ? `<div class="flash is-error" role="alert">${escapeHtml(input.discoveryError)}</div>` : ""}
    <form method="get" action="/onboarding" class="card stack" style="margin-bottom:1rem">
      <h2 class="card-title">Select workflows to protect</h2>
      <label class="field">
        <span class="field-label">Search</span>
        <input name="search" value="${escapeHtml(input.draft.search ?? "")}" placeholder="Filter by name" />
      </label>
      <div class="row-actions"><button type="submit" class="btn-secondary">Filter</button></div>
    </form>
    <form method="post" action="/onboarding/workflows/refresh" class="wizard-back-bar" style="margin-bottom:0.75rem">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <button type="submit" class="btn-secondary">Refresh workflow list</button>
    </form>
    <form method="post" action="/onboarding/workflows/select" class="card stack">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <div class="radio-card-group" style="max-height:28rem;overflow:auto">
        ${rows || "<p class='helper'>No workflows found. Refresh or use the manual fallback below.</p>"}
      </div>
      <div class="row-actions"><button type="submit">Continue</button></div>
    </form>
    <details class="card stack" style="margin-top:1rem">
      <summary class="card-title">Could not retrieve workflows automatically?</summary>
      <p class="helper">Enter a workflow ID manually. This is a fallback — discovery is preferred.</p>
      <form method="post" action="/onboarding/workflows/manual" class="stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <label class="field"><span class="field-label">Workflow name</span><input name="name" required /></label>
        <label class="field"><span class="field-label">n8n workflow ID</span><input name="externalWorkflowId" required /></label>
        <button type="submit" class="btn-secondary">Add workflow</button>
      </form>
    </details>`;
}

function renderConfigureStep(input: SimplifiedOnboardingPageInput): string {
  const configs = selectedWorkflowConfigs(input.draft);
  const cards = configs
    .map((cfg, index) => {
      const detected =
        cfg.triggerSummary && cfg.cadenceType !== "event_driven"
          ? `<p class="helper"><strong>Detected from n8n</strong> — ${escapeHtml(cfg.triggerSummary)}</p>`
          : cfg.cadenceType === "event_driven"
            ? `<p class="helper">This workflow appears to be event-driven.</p>`
            : `<p class="helper">Confirm the expected cadence below.</p>`;
      return `<div class="card stack">
        <h3 class="card-title">${escapeHtml(cfg.name)}</h3>
        ${detected}
        <input type="hidden" name="wfid__${index}" value="${escapeHtml(cfg.externalWorkflowId)}" />
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Integration mode</legend>
          <div class="radio-card-group onboarding-mode-options">
            <label class="radio-card">
              <input type="radio" name="method__${index}" value="poll" data-monitoring-mode="${index}"${cfg.monitoringMethod !== "push" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Basic monitoring</span>
                <p class="radio-card-desc">Connect Quorum to n8n using an API key. No workflow changes required.</p>
                <p class="radio-card-desc">Missing expected runs · Recorded n8n execution failures · Recovery visibility</p>
              </span>
            </label>
            <label class="radio-card">
              <input type="radio" name="method__${index}" value="push" data-monitoring-mode="${index}"${cfg.monitoringMethod === "push" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Outcome monitoring</span>
                <p class="radio-card-desc">Report useful output from inside the workflow to detect green executions that produced no useful result.</p>
                <p class="radio-card-desc">Basic monitoring capabilities where applicable · Zero useful output · Item-count range violations · Workflow-reported outcome evidence</p>
                <p class="radio-card-desc"><strong>Evidence note:</strong> workflow-reported evidence does not independently verify the downstream destination.</p>
              </span>
            </label>
          </div>
        </fieldset>
        <label class="field">
          <span class="field-label">How often should this workflow run?</span>
          <select name="cadenceType__${index}" data-cadence-select="${index}">
            <option value="interval"${cfg.cadenceType === "interval" ? " selected" : ""}>On an interval</option>
            <option value="cron"${cfg.cadenceType === "cron" ? " selected" : ""}>On a cron schedule</option>
            <option value="event_driven"${cfg.cadenceType === "event_driven" ? " selected" : ""}>Event-driven / quiet window</option>
          </select>
        </label>
        <label class="field" data-scheduled-fields="${index}"${cfg.cadenceType === "event_driven" ? " hidden" : ""}>
          <span class="field-label">Expected cadence</span>
          <input name="cadenceValue__${index}" value="${escapeHtml(cfg.cadenceValue)}" placeholder="15m or 0 9 * * 1" />
          <p class="helper">Quorum expects execution evidence within this interval.</p>
        </label>
        <label class="field" data-event-fields="${index}"${cfg.cadenceType !== "event_driven" ? " hidden" : ""}>
          <span class="field-label">Alert if no event is received for</span>
          <input name="quietHours__${index}" type="number" min="1" value="${escapeHtml(String(cfg.quietHours ?? 24))}" />
          <p class="helper">Use this for workflows that run when an external event occurs rather than on a fixed schedule. Enter hours.</p>
        </label>
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Alert me when</legend>
          <p class="helper"><strong>Schedule and execution</strong></p>
          <label class="check-row"><input type="checkbox" name="missing__${index}" value="1"${cfg.monitorMissingRuns ? " checked" : ""} /> It does not run on time</label>
          <label class="check-row"><input type="checkbox" name="failure__${index}" value="1"${cfg.monitorFailures ? " checked" : ""} /> An execution fails</label>
          <div class="stack outcome-rule-group" data-outcome-rules="${index}">
            <p class="helper"><strong>Outcome</strong></p>
            <label class="check-row"><input type="checkbox" name="empty__${index}" value="1"${cfg.monitorEmptyResult ? " checked" : ""} /> It processes zero items</label>
            <p class="helper">Requires outcome monitoring. The workflow reports how many useful items it produced.</p>
            <label class="check-row"><input type="checkbox" name="volume__${index}" value="1"${cfg.monitorVolumeRange ? " checked" : ""} /> Its item count is outside an expected range</label>
            <p class="helper">Requires outcome monitoring. Quorum compares the workflow-reported useful-item total over a daily window.</p>
            <div class="form-grid-2">
              <label class="field"><span class="field-label">Minimum useful items</span><input name="vmin__${index}" type="number" min="0" value="${cfg.volumeMin ?? ""}" /></label>
              <label class="field"><span class="field-label">Maximum useful items</span><input name="vmax__${index}" type="number" min="0" value="${cfg.volumeMax ?? ""}" /></label>
            </div>
          </div>
        </fieldset>
        <details>
          <summary>Advanced monitoring settings</summary>
          <label class="field"><span class="field-label">Timezone</span><input name="timezone__${index}" value="${escapeHtml(cfg.timezone ?? "UTC")}" /></label>
        </details>
      </div>`;
    })
    .join("");

  return `
    ${backButton(input.csrf, "select_workflows")}
    <form method="post" action="/onboarding/configure" class="stack">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <h2 class="section-title">Confirm monitoring expectations</h2>
      <p class="helper">Review what Quorum should expect for each selected workflow. Nothing is activated yet.</p>
      ${cards || "<p class='helper'>No workflows selected.</p>"}
      <div class="row-actions"><button type="submit">Continue</button></div>
    </form>`;
}

function renderAlertsStep(input: SimplifiedOnboardingPageInput): string {
  const channels = input.alertChannels
    .map(
      (c) =>
        `<label class="radio-card">
          <input type="radio" name="channelId" value="${escapeHtml(c.id)}"${input.draft.channelId === c.id ? " checked" : ""} />
          <span><span class="radio-card-title">${escapeHtml(c.name)}</span>
          <p class="radio-card-desc">Health: ${escapeHtml(c.health)}</p></span>
        </label>`,
    )
    .join("");
  return `
    ${backButton(input.csrf, "configure_monitoring")}
    <form method="post" action="/onboarding/alerts" class="card stack">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
      <h2 class="card-title">Where should alerts go?</h2>
      <p class="helper">Reuse a notification channel or create a webhook. Test before you start monitoring.</p>
      <div class="radio-card-group">
        ${channels}
        <label class="radio-card">
          <input type="radio" name="channelId" value=""${!input.draft.channelId ? " checked" : ""} />
          <span><span class="radio-card-title">Create a webhook channel</span></span>
        </label>
      </div>
      <label class="field"><span class="field-label">Channel name</span><input name="channelName" placeholder="Ops webhook" value="${escapeHtml(input.draft.channelName ?? "")}" /></label>
      <label class="field"><span class="field-label">Webhook URL</span><input name="webhookUrl" placeholder="https://…" /></label>
      <label class="check-row">
        <input type="checkbox" name="acknowledgedNoAlertMode" value="1"${input.draft.acknowledgedNoAlertMode ? " checked" : ""} />
        Continue without a notification channel (Quorum will still detect failures; no external notification will be delivered)
      </label>
      <div class="row-actions">
        <button type="submit" name="action" value="test" class="btn-secondary">Send test notification</button>
        <button type="submit" name="action" value="activate">Start monitoring</button>
      </div>
    </form>`;
}

function renderCompleteStep(input: SimplifiedOnboardingPageInput): string {
  const setups = (input.outcomeSetups ?? [])
    .map(
      (setup) => `<div class="card stack">
        <h3 class="card-title">Activate Outcome monitoring for ${escapeHtml(setup.workflowName)}</h3>
        <div class="flash is-error" role="alert">Copy the HMAC secret now. It is visible only once. Do not commit it to source control or exported workflow JSON.</div>
        <div class="copy-value-row"><span><strong>Quorum workflow ID:</strong> <code>${escapeHtml(setup.workflowId)}</code></span><button type="button" class="btn-secondary" data-copy-value="${escapeHtml(setup.workflowId)}">Copy</button></div>
        <p class="helper">Use this in the Quorum reporting step. This is not the workflow ID from the n8n URL.</p>
        <div class="copy-value-row"><span><strong>Key ID:</strong> <code>${escapeHtml(setup.keyId)}</code></span><button type="button" class="btn-secondary" data-copy-value="${escapeHtml(setup.keyId)}">Copy</button></div>
        <div class="copy-value-row"><span><strong>HMAC secret:</strong> <code>${escapeHtml(setup.secret)}</code></span><button type="button" class="btn-secondary" data-copy-value="${escapeHtml(setup.secret)}">Copy</button></div>
        <div class="copy-value-row"><span><strong>Ingest endpoint:</strong> <code>POST ${escapeHtml(setup.ingestPath)}</code></span><button type="button" class="btn-secondary" data-copy-value="${escapeHtml(setup.ingestPath)}">Copy</button></div>
        <p class="helper">Import the reusable Quorum Reporter template. Configure its Quorum base URL once and store the HMAC secret in n8n; the customer workflow supplies the Quorum workflow ID, Key ID, status, useful item count, and optional execution reference.</p>
        <div class="row-actions" style="justify-content:flex-start">
          <a class="btn btn-secondary" href="/onboarding/quorum-reporter.json?workflowId=${encodeURIComponent(setup.workflowId)}">Download Quorum Reporter</a>
          <form method="post" action="/onboarding/heartbeat/test">
            <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
            <input type="hidden" name="workflowId" value="${escapeHtml(setup.workflowId)}" />
            <button type="submit">Send test heartbeat</button>
          </form>
        </div>
      </div>`,
    )
    .join("");
  const rows = (input.completionRows ?? [])
    .map(
      (row) => `<div class="card stack">
        <h3 class="card-title">${escapeHtml(row.name)}</h3>
        <p><strong>${escapeHtml(row.statusLabel)}</strong></p>
        <p><strong>Mode:</strong> ${escapeHtml(row.monitoringMode)}</p>
        <p><strong>Alert when:</strong> ${row.alertRules.length > 0 ? escapeHtml(row.alertRules.join(" · ")) : "No workflow rules selected"}</p>
        <p><strong>Timing:</strong> ${escapeHtml(row.timingLabel)}</p>
        ${row.outcomeThreshold ? `<p><strong>Outcome threshold:</strong> ${escapeHtml(row.outcomeThreshold)}</p>` : ""}
        <p><strong>Heartbeat:</strong> ${row.monitoringMode === "Outcome monitoring" ? (row.heartbeatAccepted ? "Accepted" : "Not tested") : "Not required"}</p>
      </div>`,
    )
    .join("");
  return `
    <div class="stack">
      <h2 class="section-title">Monitoring is set up</h2>
      <p class="helper">Workflows are not labelled healthy until Quorum has enough execution evidence.</p>
      ${setups}
      ${rows}
      <div class="row-actions" style="justify-content:flex-start">
        <a class="btn" href="/catalog">Open Contract Catalog</a>
        <a class="btn btn-secondary" href="/workflows">Manage workflows</a>
        <form method="post" action="/onboarding/finish" style="display:inline">
          <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
          <button type="submit" class="btn-secondary">Done</button>
        </form>
      </div>
      <p class="helper"><a href="/onboarding">Refresh status</a> after the first n8n execution arrives.</p>
    </div>`;
}
