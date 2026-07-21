import {
  escapeHtml,
  evidenceBadge,
  layout,
  onboardingStepLabel,
  primaryNav,
  renderStepper,
} from "./layout.js";

type OnboardingStep =
  | "create_admin"
  | "choose_method"
  | "select_workflows"
  | "define_contracts"
  | "review_evidence"
  | "configure_alerts"
  | "activate"
  | "catalog";

const ONBOARDING_FLOW: Array<{ id: OnboardingStep; label: string }> = [
  { id: "choose_method", label: onboardingStepLabel("choose_method") },
  { id: "select_workflows", label: onboardingStepLabel("select_workflows") },
  { id: "define_contracts", label: onboardingStepLabel("define_contracts") },
  { id: "review_evidence", label: onboardingStepLabel("review_evidence") },
  { id: "configure_alerts", label: onboardingStepLabel("configure_alerts") },
  { id: "activate", label: onboardingStepLabel("activate") },
];

function onboardingBackButton(csrf: string, to: OnboardingStep): string {
  return `<form method="post" action="/onboarding/advance" class="wizard-back-bar">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}" />
    <input type="hidden" name="to" value="${escapeHtml(to)}" />
    <button type="submit" class="btn-secondary">Back</button>
  </form>`;
}

function nav(
  loggedIn: boolean,
  role: "admin" | "operator" | "viewer" = "admin",
  current = "",
): string {
  return primaryNav({ loggedIn, role, current });
}

export function setupErrorMessage(code: string): string {
  switch (code) {
    case "weak_password":
      return "Password is too weak. Use at least 12 characters and avoid common defaults (for example password, changeme, quorum123).";
    case "invalid_setup_token":
      return "Setup token is invalid, expired, or already used.";
    case "invalid_username":
      return "Username must be 3–64 characters: letters, numbers, and . _ - only.";
    case "admin_exists":
      return "An administrator already exists. Sign in instead.";
    default:
      return code;
  }
}

export function renderSetupPage(input: {
  demoMode?: boolean;
  flash?: string | null;
}): string {
  const flash = input.flash ? setupErrorMessage(input.flash) : null;
  return layout({
    demoMode: input.demoMode === true,
    title: "Setup",
    loggedIn: false,
    flash,
    body: `
      <h1>Create local admin</h1>
      <p class="lede">No default production password. Use the one-time setup token from the server log or <code>QUORUM_SETUP_TOKEN</code> (≥24 characters). The admin password is separate: ≥12 characters and not a known default.</p>
      <form method="post" action="/setup" class="stack">
        <label class="field">
          <span class="field-label">Setup token</span>
          <input name="setupToken" required autocomplete="off" placeholder="Paste your setup token" />
        </label>
        <label class="field">
          <span class="field-label">Username</span>
          <input name="username" required autocomplete="username" placeholder="admin" minlength="3" maxlength="64" pattern="[a-zA-Z0-9._-]{3,64}" />
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input name="password" type="password" required autocomplete="new-password" minlength="12" placeholder="At least 12 characters" />
          <p class="helper">Minimum 12 characters; avoid common defaults such as password or changeme. Store it somewhere safe.</p>
        </label>
        <button type="submit">Create administrator</button>
      </form>
    `,
  });
}

export function renderLoginPage(input: {
  demoMode?: boolean;
  flash?: string | null;
}): string {
  return layout({
    demoMode: input.demoMode === true,
    title: "Login",
    loggedIn: false,
    flash: input.flash ?? null,
    body: `
      <h1>Sign in</h1>
      <p class="lede">Access your self-hosted Quorum workspace.</p>
      <form method="post" action="/login" class="stack">
        <label class="field">
          <span class="field-label">Username</span>
          <input name="username" required autocomplete="username" />
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input name="password" type="password" required autocomplete="current-password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
    `,
  });
}

export { renderCatalogPage } from "./catalog-ui.js";

export function renderOnboardingPage(input: {
  demoMode?: boolean;
  csrf: string;
  step: OnboardingStep;
  method: string | null;
  flash?: string | null;
  flashTone?: "error" | "success";
  workflows?: Array<{
    id: string;
    name: string;
    externalWorkflowId: string;
    monitoringMethod: string;
  }>;
  contracts?: Array<{
    id: string;
    name: string;
    workflowName: string;
    cadenceType: string;
    cadenceValue: string;
    isActive?: boolean;
  }>;
  alertChannels?: Array<{
    id: string;
    name: string;
    type: string;
    isActive: boolean;
    health: string;
    lastTestedAt: string | null;
  }>;
}): string {
  const stepper = renderStepper({
    steps: ONBOARDING_FLOW,
    currentId: input.step === "catalog" ? "activate" : input.step,
  });
  const registered = input.workflows ?? [];
  const savedContracts = input.contracts ?? [];
  const alertChannels = input.alertChannels ?? [];

  let body = "";
  if (input.step === "choose_method") {
    body = `
      <form method="post" action="/onboarding/method" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">How should n8n report to Quorum?</h2>
        <p class="helper">Choose how execution evidence reaches Quorum. You can change this later per workflow.</p>
        <div class="radio-card-group" role="radiogroup" aria-label="Monitoring method">
          <label class="radio-card">
            <input type="radio" name="method" value="push" required />
            <span>
              <span class="radio-card-title">Push heartbeats <span class="badge badge-rec">Recommended</span></span>
              <p class="radio-card-desc">The workflow sends signed execution results directly to Quorum. Best for failures, item counts, silent absence, and fast detection.</p>
            </span>
          </label>
          <label class="radio-card">
            <input type="radio" name="method" value="poll" />
            <span>
              <span class="radio-card-title">Connect n8n</span>
              <p class="radio-card-desc">Quorum connects to your n8n instance and imports execution history. Useful when you cannot modify the workflow.</p>
            </span>
          </label>
        </div>
        <div class="row-actions">
          <button type="submit">Save monitoring method</button>
        </div>
      </form>`;
  } else if (input.step === "select_workflows") {
    const workflowRows =
      registered.length === 0
        ? `<div class="empty-state" style="margin-bottom:1.25rem">
            <h2>No workflows registered yet</h2>
            <p>Register one n8n workflow at a time. You can add as many as you need before continuing.</p>
          </div>`
        : `<div class="card table-wrap" style="padding:0;margin-bottom:1.25rem">
            <table class="responsive-cards">
              <thead>
                <tr><th>Name</th><th>n8n ID</th><th>Method</th><th>Quorum ID</th></tr>
              </thead>
              <tbody>
                ${registered
                  .map((w) => {
                    const methodLabel =
                      w.monitoringMethod === "poll"
                        ? "Connect n8n"
                        : "Push heartbeats";
                    return `<tr>
                      <td data-label="Name"><strong>${escapeHtml(w.name)}</strong></td>
                      <td data-label="n8n ID"><code>${escapeHtml(w.externalWorkflowId)}</code></td>
                      <td data-label="Method">${escapeHtml(methodLabel)}</td>
                      <td data-label="Quorum ID"><code>${escapeHtml(w.id)}</code></td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;
    body = `
      ${onboardingBackButton(input.csrf, "choose_method")}
      <h2 class="section-title">Registered workflows</h2>
      <p class="helper">You register one workflow at a time. Add as many as you need, then continue to define a contract.</p>
      ${workflowRows}
      <form method="post" action="/onboarding/workflows" class="card stack" id="register-workflow-form">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">Register another workflow</h2>
        <p class="helper">Register an n8n workflow before defining its monitoring contract.</p>
        <label class="field">
          <span class="field-label">Workflow name</span>
          <input name="name" required placeholder="Lead synchronization" />
          <p class="helper">A human-readable name shown in the Contract Catalog.</p>
        </label>
        <label class="field">
          <span class="field-label">n8n workflow ID</span>
          <input name="externalWorkflowId" required placeholder="Enter the ID from your n8n workflow" />
          <p class="helper">From the n8n URL: <code>http://localhost:5678/workflow/{workflow-id}</code>. After registration, use the Quorum ID column for <code>QUORUM_WORKFLOW_ID</code> — not this n8n id.</p>
        </label>
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Monitoring method</legend>
          <div class="radio-card-group" role="radiogroup" aria-label="Monitoring method">
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="push"${input.method !== "poll" ? " checked" : ""} required />
              <span>
                <span class="radio-card-title">Push heartbeats <span class="badge badge-rec">Recommended</span></span>
                <p class="radio-card-desc">Best for precise status, item counts, failures, and immediate reporting.</p>
              </span>
            </label>
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="poll"${input.method === "poll" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Connect n8n</span>
                <p class="radio-card-desc">Quorum reads workflow executions through the n8n API.</p>
              </span>
            </label>
          </div>
        </fieldset>
        <div class="row-actions">
          <button type="submit">Register workflow</button>
        </div>
      </form>
      <form method="post" action="/onboarding/advance" class="card">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="to" value="define_contracts" />
        <div class="row-actions">
          <button type="submit" class="btn-secondary"${registered.length === 0 ? " disabled" : ""}>Continue to contract</button>
        </div>
        ${
          registered.length === 0
            ? `<p class="helper">Register at least one workflow before continuing.</p>`
            : `<p class="helper">Pick a workflow from the list when you define its contract.</p>`
        }
      </form>`;
  } else if (input.step === "define_contracts") {
    const workflowOptions =
      registered.length === 0
        ? `<option value="">No workflows registered</option>`
        : registered
            .map(
              (w) =>
                `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.externalWorkflowId)})</option>`,
            )
            .join("");
    const contractRows =
      savedContracts.length === 0
        ? `<div class="empty-state" style="margin-bottom:1.25rem">
            <h2>No contracts yet</h2>
            <p>Save one inactive contract at a time. You can add more before continuing.</p>
          </div>`
        : `<div class="card table-wrap" style="padding:0;margin-bottom:1.25rem">
            <table class="responsive-cards">
              <thead>
                <tr><th>Contract</th><th>Workflow</th><th>Cadence</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${savedContracts
                  .map((c) => {
                    const status = c.isActive ? "Active" : "Inactive";
                    return `<tr>
                      <td data-label="Contract"><strong>${escapeHtml(c.name)}</strong></td>
                      <td data-label="Workflow">${escapeHtml(c.workflowName)}</td>
                      <td data-label="Cadence"><code>${escapeHtml(c.cadenceType)}: ${escapeHtml(c.cadenceValue)}</code></td>
                      <td data-label="Status">${escapeHtml(status)}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;
    body = `
      ${onboardingBackButton(input.csrf, "select_workflows")}
      <h2 class="section-title">Saved contracts</h2>
      <p class="helper">Contracts stay inactive until you activate monitoring later. Add as many as you need, then continue.</p>
      ${contractRows}
      <form method="post" action="/onboarding/contracts" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">${savedContracts.length === 0 ? "Define the monitoring contract" : "Define another contract"}</h2>
        <p class="helper">Quorum will not invent a schedule. Confirm what this workflow should do.</p>
        <label class="field">
          <span class="field-label">Workflow</span>
          <select name="workflowId" required${registered.length === 0 ? " disabled" : ""}>${workflowOptions}</select>
          <p class="helper">Choose one of the workflows you registered in the previous step.</p>
        </label>
        <label class="field">
          <span class="field-label">Contract name</span>
          <input name="name" required placeholder="Lead delivery heartbeat" />
        </label>
        <label class="field">
          <span class="field-label">Business purpose</span>
          <input name="businessPurpose" required placeholder="Leads reach CRM every 15 minutes" />
        </label>
        <label class="field">
          <span class="field-label">Cadence type</span>
          <select name="cadenceType">
            <option value="interval">Interval (minutes)</option>
            <option value="cron">Cron</option>
            <option value="event_driven">Event driven</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Cadence value</span>
          <input name="cadenceValue" required placeholder="15 or a cron expression" />
        </label>
        <label class="field">
          <span class="field-label">Timezone</span>
          <input name="timezone" value="UTC" />
        </label>
        <label class="check-row">
          <input type="checkbox" name="explicitlyConfirmed" value="1" required />
          <span>I confirm this contract explicitly</span>
        </label>
        <div class="row-actions">
          <button type="submit"${registered.length === 0 ? " disabled" : ""}>Save contract</button>
        </div>
      </form>
      <form method="post" action="/onboarding/advance" class="card">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="to" value="review_evidence" />
        <div class="row-actions">
          <button type="submit"${savedContracts.length === 0 ? ' class="btn-secondary" disabled' : ""}>Continue to evidence</button>
        </div>
        ${
          savedContracts.length === 0
            ? `<p class="helper">Save at least one contract before continuing.</p>`
            : `<p class="helper">Your contract is saved as inactive. Continue when you are ready to review evidence.</p>`
        }
      </form>`;
  } else if (input.step === "review_evidence") {
    body = `
      ${onboardingBackButton(input.csrf, "define_contracts")}
      <div class="card stack">
        <h2 class="card-title">Review evidence strength</h2>
        <p>${evidenceBadge("basic")}</p>
        <p>Default evidence level for heartbeats is Basic.</p>
        <p class="helper"><strong>Verified:</strong> workflow reported executions.</p>
        <p class="helper"><strong>Not verified:</strong> destination delivery, business outcome completeness, and payload authenticity beyond HMAC.</p>
        <p class="helper">A healthy heartbeat with a missing destination outcome stays healthy with Basic evidence. It must not claim delivery proof.</p>
      </div>
      <form method="post" action="/onboarding/advance" class="card">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="to" value="configure_alerts" />
        <div class="row-actions">
          <button type="submit">Configure alerts</button>
        </div>
      </form>`;
  } else if (input.step === "configure_alerts") {
    const channelRows =
      alertChannels.length === 0
        ? `<div class="empty-state" style="margin-bottom:1.25rem">
            <h2>No alert channels yet</h2>
            <p>Create a webhook channel so Quorum can notify your team when contracts break.</p>
          </div>`
        : `<div class="card table-wrap" style="padding:0;margin-bottom:1.25rem">
            <table class="responsive-cards">
              <thead>
                <tr><th>Name</th><th>Type</th><th>Health</th><th>Last tested</th></tr>
              </thead>
              <tbody>
                ${alertChannels
                  .map(
                    (ch) => `<tr>
                      <td data-label="Name"><strong>${escapeHtml(ch.name)}</strong></td>
                      <td data-label="Type">${escapeHtml(ch.type)}</td>
                      <td data-label="Health">${escapeHtml(ch.health)}</td>
                      <td data-label="Last tested" class="muted">${escapeHtml(ch.lastTestedAt ?? "never")}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`;
    body = `
      ${onboardingBackButton(input.csrf, "review_evidence")}
      <h2 class="section-title">Alert channels</h2>
      <p class="helper">Quorum needs a tested route so incidents reach your team.</p>
      ${channelRows}
      <form method="post" action="/onboarding/alerts" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">${alertChannels.length === 0 ? "Configure alerts" : "Add another channel"}</h2>
        <label class="field">
          <span class="field-label">Channel name</span>
          <input name="name" required value="Ops webhook" />
        </label>
        <label class="field">
          <span class="field-label">Webhook URL</span>
          <input name="url" required placeholder="https://hooks.example.com/..." />
        </label>
        <div class="row-actions">
          <button type="submit">Create and test channel</button>
        </div>
      </form>
      <form method="post" action="/onboarding/advance" class="card">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <input type="hidden" name="to" value="activate" />
        <div class="row-actions">
          <button type="submit"${alertChannels.length === 0 ? ' class="btn-secondary" disabled' : ""}>Continue to activation</button>
        </div>
        ${
          alertChannels.length === 0
            ? `<p class="helper">Create and test at least one channel before continuing.</p>`
            : `<p class="helper">Your channel is ready. Continue when you want to activate monitoring.</p>`
        }
      </form>`;
  } else if (input.step === "activate") {
    const inactiveContracts = savedContracts.filter((c) => !c.isActive);
    const activeContracts = savedContracts.filter((c) => c.isActive);
    const contractOptions =
      inactiveContracts.length === 0
        ? `<option value="">${savedContracts.length === 0 ? "No contracts defined" : "All contracts already active"}</option>`
        : inactiveContracts
            .map(
              (c) =>
                `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} · ${escapeHtml(c.workflowName)}</option>`,
            )
            .join("");
    const contractRows =
      savedContracts.length === 0
        ? `<div class="empty-state" style="margin-bottom:1.25rem">
            <h2>No contracts to activate</h2>
            <p>Go back and define a contract before activating monitoring.</p>
          </div>`
        : `<div class="card table-wrap" style="padding:0;margin-bottom:1.25rem">
            <table class="responsive-cards">
              <thead>
                <tr><th>Contract</th><th>Workflow</th><th>Cadence</th><th>Status</th></tr>
              </thead>
              <tbody>
                ${savedContracts
                  .map((c) => {
                    const status = c.isActive ? "Active" : "Inactive";
                    return `<tr>
                      <td data-label="Contract"><strong>${escapeHtml(c.name)}</strong></td>
                      <td data-label="Workflow">${escapeHtml(c.workflowName)}</td>
                      <td data-label="Cadence"><code>${escapeHtml(c.cadenceType)}: ${escapeHtml(c.cadenceValue)}</code></td>
                      <td data-label="Status">${escapeHtml(status)}</td>
                    </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>`;
    body = `
      ${onboardingBackButton(input.csrf, "configure_alerts")}
      <h2 class="section-title">Contracts</h2>
      <p class="helper">Activation starts cadence evaluation for the selected contract.</p>
      ${contractRows}
      <form method="post" action="/onboarding/activate" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">Activate monitoring</h2>
        <label class="field">
          <span class="field-label">Contract</span>
          <select name="contractId" required${inactiveContracts.length === 0 ? " disabled" : ""}>${contractOptions}</select>
        </label>
        <label class="check-row">
          <input type="checkbox" name="explicitlyConfirmed" value="1" required${inactiveContracts.length === 0 ? " disabled" : ""} />
          <span>Activate monitoring for this contract</span>
        </label>
        <div class="row-actions">
          <button type="submit"${inactiveContracts.length === 0 ? " disabled" : ""}>Activate monitoring</button>
        </div>
      </form>
      <form method="post" action="/onboarding/finish" class="card">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <div class="row-actions">
          <button type="submit"${activeContracts.length === 0 ? ' class="btn-secondary" disabled' : ""}>Open Contract Catalog</button>
        </div>
        ${
          activeContracts.length === 0
            ? `<p class="helper">Activate at least one contract before opening the catalog.</p>`
            : `<p class="helper">Monitoring is running. Finish onboarding to open the Contract Catalog.</p>`
        }
      </form>`;
  } else {
    body = `<div class="empty-state">
      <h2>Onboarding complete</h2>
      <p>Your first monitoring path is ready.</p>
      <a class="btn" href="/catalog">Open Contract Catalog</a>
    </div>`;
  }

  return layout({
    demoMode: input.demoMode === true,
    title: "Onboarding",
    nav: nav(true, "admin", "settings"),
    current: "settings",
    flash: input.flash ?? null,
    flashTone: input.flashTone ?? "error",
    pageTitle: "Set up workflow monitoring",
    body: `
      <h1 class="page-title">Set up workflow monitoring</h1>
      <p class="page-subtitle">Connect your first workflow and define what Quorum should expect.</p>
      ${stepper}
      ${body}
    `,
  });
}

export function renderNetworkPrivacyPage(input: {
  demoMode?: boolean;
  destinations: Array<{
    kind: string;
    label: string;
    destination: string;
    lastAttemptAt: string | null;
    lastAttemptStatus: string | null;
    lastErrorSummary: string | null;
  }>;
}): string {
  const rows =
    input.destinations.length === 0
      ? `<tr><td colspan="4" class="muted">No configured outbound destinations. Quorum does not phone home.</td></tr>`
      : input.destinations
          .map(
            (d) => `<tr>
              <td data-label="Kind">${escapeHtml(d.kind)}</td>
              <td data-label="Label">${escapeHtml(d.label)}</td>
              <td data-label="Destination"><code>${escapeHtml(d.destination)}</code></td>
              <td data-label="Last attempt" class="muted">${escapeHtml(d.lastAttemptAt ?? "never")} · ${escapeHtml(d.lastAttemptStatus ?? "—")}${
                d.lastErrorSummary
                  ? `<br/>${escapeHtml(d.lastErrorSummary)}`
                  : ""
              }</td>
            </tr>`,
          )
          .join("");

  return layout({
    demoMode: input.demoMode === true,
    title: "Network and Privacy",
    nav: nav(true, "admin", "settings"),
    current: "settings",
    pageTitle: "Network and privacy",
    body: `
      <h1 class="page-title">Network and privacy</h1>
      <p class="page-subtitle">Self-hosted Quorum has zero telemetry. Outbound calls only go to destinations you configure (n8n, webhooks, SMTP).</p>
      <div class="card table-wrap" style="padding:0">
        <table class="responsive-cards">
          <thead><tr><th>Kind</th><th>Label</th><th>Destination</th><th>Last attempt</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `,
  });
}

export function renderCredentialOncePage(input: {
  demoMode?: boolean;
 
  workflowId: string;
  keyId: string;
  secret: string;
  ingestPath: string;
}): string {
  return layout({
    demoMode: input.demoMode === true,
    title: "Credential",
    nav: nav(true, "admin", "workflows"),
    current: "workflows",
    pageTitle: "Push credential",
    body: `
      <h1 class="page-title">Push credential</h1>
      <div class="flash is-error" role="alert">Copy now. Quorum stores only encrypted material and will not show this secret again.</div>
      <div class="card stack">
        <p>Quorum workflow id: <code>${escapeHtml(input.workflowId)}</code></p>
        <p class="helper">Use this value for <code>QUORUM_WORKFLOW_ID</code>. It is not the n8n workflow id from the n8n URL.</p>
        <p>Key id: <code>${escapeHtml(input.keyId)}</code></p>
        <p>Secret: <code>${escapeHtml(input.secret)}</code></p>
        <p>Ingest: <code>POST ${escapeHtml(input.ingestPath)}</code></p>
      </div>
      <p class="helper">Credentials alone do not activate monitoring. Define a contract and activate it next.</p>
      <div class="row-actions" style="justify-content:flex-start">
        <a class="btn" href="/protect">Next: define contract &amp; activate</a>
        <a class="btn btn-secondary" href="/workflows">Back to workflows</a>
      </div>
    `,
  });
}

export function renderWorkflowsPage(input: {
  demoMode?: boolean;
  csrf: string;
  connectors?: Array<{ id: string; name: string }>;
  workflows: Array<{
    id: string;
    name: string;
    externalWorkflowId: string;
    monitoringMethod: string;
    isActive: boolean;
    connectorId?: string | null;
  }>;
  flash?: string | null;
  flashTone?: "error" | "success";
  draft?: {
    name?: string;
    externalWorkflowId?: string;
    monitoringMethod?: string;
  };
}): string {
  const connectors = input.connectors ?? [];
  const draft = input.draft ?? {};
  const method = draft.monitoringMethod === "poll" ? "poll" : "push";
  const connectorOptions = connectors
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`,
    )
    .join("");

  const rows = input.workflows
    .map((w) => {
      const methodLabel =
        w.monitoringMethod === "poll" ? "Connect n8n" : "Push heartbeats";
      const pushCredential = `<form method="post" action="/workflows/${escapeHtml(w.id)}/credentials" style="display:inline">
            <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
            <button type="submit" class="btn-secondary">Issue push credential</button>
          </form>`;
      const bindForm =
        w.monitoringMethod === "poll"
          ? `<form method="post" action="/workflows/${escapeHtml(w.id)}/connector" style="display:inline">
            <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
            <select name="connectorId" required aria-label="Connector for ${escapeHtml(w.name)}">${connectorOptions || `<option value="">No connectors</option>`}</select>
            <button type="submit" ${connectors.length === 0 ? "disabled" : ""}>Bind connector</button>
          </form>`
          : "";
      const bound =
        w.connectorId != null && w.connectorId !== ""
          ? `<div class="helper">Bound: <code>${escapeHtml(w.connectorId)}</code></div>`
          : w.monitoringMethod === "poll"
            ? `<div class="helper">No connector bound</div>`
            : "";
      const inactiveNext = w.isActive
        ? ""
        : `<div class="stack" style="gap:0.35rem;margin-top:0.5rem">
            <p class="helper">Inactive means there is no active contract yet. Heartbeats return <code>NOT_FOUND</code> until you define a contract and activate monitoring.</p>
            <a class="btn btn-secondary" href="/protect">Define contract &amp; activate</a>
          </div>`;
      return `<tr>
        <td data-label="Name"><strong>${escapeHtml(w.name)}</strong></td>
        <td data-label="n8n ID"><code>${escapeHtml(w.externalWorkflowId)}</code></td>
        <td data-label="Quorum ID"><code>${escapeHtml(w.id)}</code></td>
        <td data-label="Method">${escapeHtml(methodLabel)}</td>
        <td data-label="Status">${w.isActive ? `<span class="badge badge-status-healthy">Active</span>` : `<span class="badge badge-status-paused">Inactive</span>`}</td>
        <td data-label="Actions">
          ${w.monitoringMethod === "push" ? pushCredential : bindForm}
          ${bound}
          ${inactiveNext}
        </td>
      </tr>`;
    })
    .join("");

  const list =
    input.workflows.length === 0
      ? `<div class="empty-state">
          <h2>No workflows registered</h2>
          <p>Connect an n8n workflow to start defining monitoring contracts.</p>
        </div>`
      : `<div class="card table-wrap" style="padding:0">
        <table class="responsive-cards">
          <thead><tr><th>Name</th><th>n8n ID</th><th>Quorum ID</th><th>Method</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  return layout({
    demoMode: input.demoMode === true,
    title: "Workflows",
    nav: nav(true, "admin", "workflows"),
    current: "workflows",
    pageTitle: "Workflows",
    flash: input.flash ?? null,
    flashTone: input.flashTone ?? "error",
    body: `
      <h1 class="page-title">Workflows</h1>
      <p class="page-subtitle">Register an n8n workflow, then define a contract and activate monitoring. Registration alone does not accept heartbeats.</p>
      <form method="post" action="/workflows" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">Register a workflow</h2>
        <p class="helper">The n8n workflow id comes from the n8n URL. Quorum assigns a separate Quorum workflow id for <code>QUORUM_WORKFLOW_ID</code> after registration.</p>
        <label class="field">
          <span class="field-label">Workflow name</span>
          <input name="name" required placeholder="Lead synchronization" value="${escapeHtml(draft.name ?? "")}" />
        </label>
        <label class="field">
          <span class="field-label">n8n workflow ID</span>
          <input name="externalWorkflowId" required placeholder="Enter the ID from your n8n workflow" value="${escapeHtml(draft.externalWorkflowId ?? "")}" />
          <p class="helper">From the n8n URL: <code>http://localhost:5678/workflow/{workflow-id}</code>. This is not the Quorum workflow id.</p>
        </label>
        <fieldset class="stack" style="border:0;padding:0;margin:0">
          <legend class="field-label">Monitoring method</legend>
          <div class="radio-card-group" role="radiogroup" aria-label="Monitoring method">
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="push"${method !== "poll" ? " checked" : ""} required />
              <span>
                <span class="radio-card-title">Push heartbeats <span class="badge badge-rec">Recommended</span></span>
                <p class="radio-card-desc">The workflow sends signed execution results directly to Quorum.</p>
              </span>
            </label>
            <label class="radio-card">
              <input type="radio" name="monitoringMethod" value="poll"${method === "poll" ? " checked" : ""} />
              <span>
                <span class="radio-card-title">Connect n8n</span>
                <p class="radio-card-desc">Quorum connects to your n8n instance and imports execution history.</p>
              </span>
            </label>
          </div>
        </fieldset>
        <div class="row-actions">
          <button type="submit">Register workflow</button>
        </div>
      </form>
      ${list}
    `,
  });
}

export function renderAlertsPage(input: {
  demoMode?: boolean;
  csrf: string;
  channels: Array<{
    id: string;
    name: string;
    type: string;
    health: string;
  }>;
}): string {
  const rows = input.channels
    .map(
      (c) => `<tr>
        <td data-label="Name"><a href="/alerts/${escapeHtml(c.id)}">${escapeHtml(c.name)}</a></td>
        <td data-label="Type">${escapeHtml(c.type)}</td>
        <td data-label="Health" class="channel-${escapeHtml(c.health)}">${escapeHtml(c.health)}</td>
        <td data-label="Actions">
          <form method="post" action="/alerts/${escapeHtml(c.id)}/test" style="display:inline">
            <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
            <button type="submit" class="btn-secondary">Send test alert</button>
          </form>
        </td>
      </tr>`,
    )
    .join("");

  return layout({
    demoMode: input.demoMode === true,
    title: "Alert channels",
    nav: nav(true, "admin", "alerts"),
    current: "alerts",
    pageTitle: "Alert channels",
    body: `
      <h1 class="page-title">Alert channels</h1>
      <p class="page-subtitle">Deliver incident notifications to your team.</p>
      <form method="post" action="/alerts" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
        <h2 class="card-title">Create webhook channel</h2>
        <label class="field">
          <span class="field-label">Name</span>
          <input name="name" required placeholder="Ops webhook" />
        </label>
        <label class="field">
          <span class="field-label">Webhook URL</span>
          <input name="url" required placeholder="https://..." />
        </label>
        <div class="row-actions">
          <button type="submit">Create webhook channel</button>
        </div>
      </form>
      ${
        input.channels.length === 0
          ? `<div class="empty-state"><h2>No alert channels</h2><p>Create a webhook channel so incidents can reach your team.</p></div>`
          : `<div class="card table-wrap" style="padding:0">
        <table class="responsive-cards">
          <thead><tr><th>Name</th><th>Type</th><th>Health</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
      }
    `,
  });
}

export function renderOutcomeEvidencePage(input: {
  demoMode?: boolean;
  csrf: string;
  contractId: string;
  businessPurpose: string;
  evidenceLevel: string;
  evidenceStale: boolean;
  lastVerifiedWindow: string | null;
  run: {
    id: string;
    status: string;
    sourceCount: number;
    destinationCount: number;
    matchedCount: number;
    missingCount: number;
    duplicateCount: number;
    lateCount: number;
    waitingCount: number;
    evidenceLevelAchieved: string;
  } | null;
  items: Array<{
    matchStatus: string;
    sourceIdentifierHash: string;
  }>;
  incidentSummary: string | null;
}): string {
  const runBlock = input.run
    ? `<div class="card stack">
        <p>${evidenceBadge(input.evidenceLevel, input.evidenceStale)}</p>
        <p class="helper">Last verified window: ${escapeHtml(input.lastVerifiedWindow ?? "none")}</p>
        <p>Source: ${input.run.sourceCount} · Destination: ${input.run.destinationCount} · Matched: ${input.run.matchedCount} · Missing: ${input.run.missingCount} · Waiting: ${input.run.waitingCount} · Late: ${input.run.lateCount} · Duplicates: ${input.run.duplicateCount}</p>
        <p>Run status: ${escapeHtml(input.run.status)} · achieved ${escapeHtml(input.run.evidenceLevelAchieved)}</p>
      </div>`
    : `<div class="empty-state"><h2>No reconciliation run yet</h2><p>Outcome evidence appears after the first successful reconciliation.</p></div>`;

  const itemRows = input.items
    .slice(0, 50)
    .map(
      (i) =>
        `<tr><td data-label="Status">${escapeHtml(formatMatchStatusLabel(i.matchStatus))}</td><td data-label="Hash"><code>${escapeHtml(i.sourceIdentifierHash.slice(0, 16))}…</code></td></tr>`,
    )
    .join("");

  return layout({
    demoMode: input.demoMode === true,
    title: "Outcome evidence",
    nav: nav(true, "admin", "catalog"),
    current: "catalog",
    pageTitle: input.businessPurpose,
    body: `
      <h1 class="page-title">${escapeHtml(input.businessPurpose)}</h1>
      <p class="page-subtitle">Outcome contract <code>${escapeHtml(input.contractId)}</code></p>
      ${
        input.incidentSummary
          ? `<div class="flash is-error" role="alert">${escapeHtml(input.incidentSummary)}</div>`
          : ""
      }
      ${runBlock}
      <div class="card stack">
        <h2 class="card-title">Affected identifier hashes</h2>
        <p class="helper">Raw emails are never stored. Export issues an expiring one-time token (audit logged).</p>
        <div class="table-wrap" style="padding:0;border:0">
          <table class="responsive-cards">
            <thead><tr><th>Status</th><th>Source hash</th></tr></thead>
            <tbody>${itemRows || `<tr><td colspan="2" class="muted">None</td></tr>`}</tbody>
          </table>
        </div>
        ${
          input.run
            ? `<form method="post" action="/catalog/outcome/${escapeHtml(input.contractId)}/export" class="stack">
                <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
                <input type="hidden" name="runId" value="${escapeHtml(input.run.id)}" />
                <button type="submit">Create export token</button>
              </form>
              <form method="post" action="/catalog/outcome/${escapeHtml(input.contractId)}/waive" class="stack">
                <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}" />
                <button type="submit" class="btn-secondary">Waive missing (audit)</button>
              </form>`
            : ""
        }
      </div>
      <p><a href="/catalog">Back to catalog</a></p>
    `,
  });
}

function formatMatchStatusLabel(status: string): string {
  if (status === "waiting") {
    return "waiting (in delivery delay)";
  }
  return status;
}
