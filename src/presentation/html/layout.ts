/**
 * Shared HTML shell and design system.
 * Self-hosted: no remote fonts, CDNs, analytics, or undeclared outbound assets.
 */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Human-readable labels for legacy onboarding step IDs (DB still stores snake_case). */
export const ONBOARDING_STEP_LABELS: Record<string, string> = {
  create_admin: "Create admin",
  choose_method: "Monitoring method",
  select_workflows: "Select workflow",
  define_contracts: "Define contract",
  review_evidence: "Review evidence",
  configure_alerts: "Configure alerts",
  activate: "Activate",
  catalog: "Catalog",
};

export function onboardingStepLabel(step: string): string {
  return ONBOARDING_STEP_LABELS[step] ?? step.replaceAll("_", " ");
}

export const BASE_CSS = `
:root {
  --background-app: #f4f5f7;
  --background-surface: #ffffff;
  --background-muted: #eef0f3;
  --background-hover: #f0f2f5;
  --text-primary: #111827;
  --text-secondary: #4b5563;
  --text-muted: #6b7280;
  --border-default: #e5e7eb;
  --border-strong: #d1d5db;
  --brand-primary: #0d6b5c;
  --brand-primary-hover: #0a574b;
  --brand-primary-subtle: #e6f4f1;
  --status-success: #047857;
  --status-success-bg: #ecfdf5;
  --status-warning: #b45309;
  --status-warning-bg: #fffbeb;
  --status-danger: #b91c1c;
  --status-danger-bg: #fef2f2;
  --status-info: #1d4ed8;
  --status-info-bg: #eff6ff;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --shadow-sm: 0 1px 2px rgba(17, 24, 39, 0.05);
  --shadow-md: 0 4px 12px rgba(17, 24, 39, 0.08);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-7: 2rem;
  --space-8: 2.5rem;
  --sidebar-width: 248px;
  --topbar-height: 56px;
  --control-height: 42px;
  --font-sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --focus-ring: 0 0 0 3px rgba(13, 107, 92, 0.28);
  /* Legacy aliases used by older class names */
  --bg: var(--background-app);
  --ink: var(--text-primary);
  --muted: var(--text-muted);
  --line: var(--border-default);
  --card: var(--background-surface);
  --accent: var(--brand-primary);
  --warn: var(--status-warning);
  --bad: var(--status-danger);
  --ok: var(--status-success);
  --banner: var(--status-warning-bg);
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  font-family: var(--font-sans);
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--background-app);
}
a { color: var(--brand-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, summary:focus-visible,
.radio-card:focus-within, .nav-link:focus-visible, .icon-btn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.skip-link {
  position: absolute; left: -9999px; top: 0; z-index: 100;
  background: var(--background-surface); padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-sm); box-shadow: var(--shadow-md);
}
.skip-link:focus { left: var(--space-4); top: var(--space-4); }

/* Auth / unauthenticated shell */
.auth-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--space-6);
  background:
    radial-gradient(circle at 10% 0%, var(--brand-primary-subtle), transparent 42%),
    var(--background-app);
}
.auth-card {
  width: 100%;
  max-width: 420px;
  background: var(--background-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  padding: var(--space-7);
}
.auth-card .brand-mark {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: var(--space-5);
  color: var(--text-primary);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.auth-card h1 {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 var(--space-2);
  letter-spacing: -0.02em;
}

/* App shell */
.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: var(--sidebar-width) 1fr;
}
.app-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--background-surface);
  border-right: 1px solid var(--border-default);
  padding: var(--space-4) var(--space-3);
  z-index: 30;
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-4);
  font-weight: 700;
  font-size: 1.05rem;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  text-decoration: none;
}
.sidebar-brand:hover { text-decoration: none; }
.brand-glyph {
  width: 28px; height: 28px; border-radius: 8px;
  background: var(--brand-primary); color: #fff;
  display: inline-grid; place-items: center;
  font-size: 0.85rem; font-weight: 700;
  flex-shrink: 0;
}
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  overflow-y: auto;
}
.nav-section-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: var(--space-3) var(--space-3) var(--space-1);
}
.nav-link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0.55rem var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: background 150ms ease, color 150ms ease;
}
.nav-link:hover {
  background: var(--background-hover);
  color: var(--text-primary);
  text-decoration: none;
}
.nav-link[aria-current="page"] {
  background: var(--brand-primary-subtle);
  color: var(--brand-primary);
  font-weight: 600;
}
.nav-link.nav-cta {
  margin-top: var(--space-2);
  background: var(--brand-primary);
  color: #fff !important;
  justify-content: center;
}
.nav-link.nav-cta:hover { background: var(--brand-primary-hover); }
.sidebar-footer {
  border-top: 1px solid var(--border-default);
  padding-top: var(--space-3);
  margin-top: var(--space-3);
  display: grid;
  gap: 2px;
}
.sidebar-meta {
  padding: var(--space-2) var(--space-3);
  font-size: 12px;
  color: var(--text-muted);
}
.org-chip {
  display: block;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--background-muted);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  margin-bottom: var(--space-2);
}

.app-main-column {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.app-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: var(--topbar-height);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-6);
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-default);
}
.menu-toggle {
  display: none;
  width: 36px; height: 36px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--background-surface);
  cursor: pointer;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  font-size: 18px;
  padding: 0;
}
.topbar-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.01em;
}
.topbar-breadcrumb {
  color: var(--text-muted);
  font-size: 13px;
}
.topbar-spacer { flex: 1; }
.topbar-status {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--background-muted);
  border-radius: 999px;
  padding: 0.2rem 0.6rem;
}
.app-content {
  flex: 1;
  padding: var(--space-6);
  max-width: 1120px;
  width: 100%;
}
.app-content.wide { max-width: 1280px; }
.app-footer {
  padding: var(--space-4) var(--space-6) var(--space-6);
  color: var(--text-muted);
  font-size: 12px;
  max-width: 1120px;
}
.sidebar-backdrop {
  display: none;
  position: fixed; inset: 0;
  background: rgba(17,24,39,0.4);
  z-index: 25;
}

/* Typography */
h1.page-title, .page-title {
  font-size: 1.75rem;
  font-weight: 600;
  letter-spacing: -0.03em;
  margin: 0 0 var(--space-2);
  line-height: 1.25;
}
h2.section-title, .section-title {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 0 0 var(--space-3);
  letter-spacing: -0.02em;
}
h3.card-title, .card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 var(--space-2);
}
.page-subtitle, .lede {
  color: var(--text-secondary);
  font-size: 14.5px;
  margin: 0 0 var(--space-6);
  max-width: 42rem;
}
.muted { color: var(--text-muted); }
.err, .form-error { color: var(--status-danger); font-size: 13px; }
.helper { color: var(--text-muted); font-size: 13px; margin: var(--space-1) 0 0; }
.question { font-size: 1rem; color: var(--text-secondary); margin: 0 0 var(--space-5); }

/* Surfaces */
.card {
  background: var(--background-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  padding: var(--space-5);
  margin: 0 0 var(--space-4);
}
.card.compact { padding: var(--space-4); }
.stack { display: grid; gap: var(--space-4); }
.stack-sm { display: grid; gap: var(--space-2); }
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: flex-end;
  align-items: center;
  margin-top: var(--space-5);
}
.summary-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
  margin: 0 0 var(--space-5);
}
.summary-grid .card { margin: 0; }
.summary-grid .card strong {
  display: block;
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.02em;
}

/* Forms */
.field { display: grid; gap: var(--space-1); margin: 0; }
.field-label, label.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
}
label:not(.field-label):not(.radio-card):not(.check-row) {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
}
input[type="text"], input[type="password"], input[type="url"],
input[type="number"], input[type="email"], input[type="search"],
input:not([type]), select, textarea {
  width: 100%;
  max-width: 100%;
  min-height: var(--control-height);
  padding: 0.55rem 0.75rem;
  font: inherit;
  color: var(--text-primary);
  background: var(--background-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
textarea { min-height: 5.5rem; resize: vertical; }
input:hover, select:hover, textarea:hover { border-color: var(--border-strong); }
input:disabled, select:disabled, textarea:disabled, button:disabled {
  opacity: 0.55; cursor: not-allowed;
}
.field-error input, .field-error select, .field-error textarea,
input[aria-invalid="true"], select[aria-invalid="true"] {
  border-color: var(--status-danger);
}
.check-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-weight: 400;
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}
.check-row input { width: auto; min-height: 0; margin-top: 0.2rem; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: end;
}
.filters label { margin: 0; min-width: 9rem; }
.filters select, .filters input { max-width: 14rem; }

.radio-card-group {
  display: grid;
  gap: var(--space-3);
}
.radio-card {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-3);
  align-items: start;
  padding: var(--space-4);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--background-surface);
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, box-shadow 150ms ease;
}
.radio-card:hover { border-color: var(--border-strong); background: var(--background-hover); }
.radio-card:has(input:checked), .radio-card.is-selected {
  border-color: var(--brand-primary);
  background: var(--brand-primary-subtle);
  box-shadow: 0 0 0 1px var(--brand-primary);
}
.radio-card input { width: auto; min-height: 0; margin-top: 0.2rem; }
.radio-card-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 600;
  font-size: 14.5px;
  color: var(--text-primary);
}
.radio-card-desc {
  margin: var(--space-1) 0 0;
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 400;
}

/* Buttons */
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: var(--control-height);
  padding: 0.55rem 1rem;
  font: inherit;
  font-weight: 550;
  font-size: 14px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  width: auto;
  max-width: none;
  text-decoration: none;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
}
button, .btn, .btn-primary {
  background: var(--brand-primary);
  color: #fff;
}
button:hover, .btn:hover, .btn-primary:hover {
  background: var(--brand-primary-hover);
  text-decoration: none;
  color: #fff;
}
.btn-secondary, button.btn-secondary {
  background: var(--background-surface);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.btn-secondary:hover, button.btn-secondary:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}
.btn-ghost, button.btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border-color: transparent;
}
.btn-ghost:hover, button.btn-ghost:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}
.btn-danger, button.btn-danger {
  background: var(--status-danger);
  color: #fff;
}
.btn-danger:hover { background: #991b1b; color: #fff; }
.cta {
  background: var(--brand-primary);
  color: #fff !important;
  padding: 0.45rem 0.85rem;
  border-radius: var(--radius-sm);
  text-decoration: none;
  font-weight: 550;
}
.cta:hover { background: var(--brand-primary-hover); text-decoration: none; }
form[style*="display:inline"] button,
td form button {
  min-height: 34px;
  padding: 0.35rem 0.7rem;
  font-size: 13px;
  width: auto;
}

/* Badges */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--background-muted);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.4;
  white-space: nowrap;
}
.badge.basic, .badge-evidence-basic {
  background: var(--status-info-bg);
  border-color: #bfdbfe;
  color: var(--status-info);
}
.badge.medium, .badge-evidence-medium {
  background: var(--status-warning-bg);
  border-color: #fde68a;
  color: var(--status-warning);
}
.badge.high, .badge-evidence-high {
  background: var(--status-success-bg);
  border-color: #a7f3d0;
  color: var(--status-success);
}
.badge-status-healthy { background: var(--status-success-bg); border-color: #a7f3d0; color: var(--status-success); }
.badge-status-warning, .badge-status-waiting { background: var(--status-warning-bg); border-color: #fde68a; color: var(--status-warning); }
.badge-status-overdue, .badge-status-incident { background: var(--status-danger-bg); border-color: #fecaca; color: var(--status-danger); }
.badge-status-unknown, .badge-status-paused, .badge-status-inactive {
  background: var(--background-muted); border-color: var(--border-default); color: var(--text-muted);
}
.badge-rec {
  background: var(--brand-primary);
  border-color: var(--brand-primary);
  color: #fff;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.health-overdue, .sev-critical { color: var(--status-danger); }
.health-healthy { color: var(--status-success); }
.health-warning, .channel-failing, .channel-degraded { color: var(--status-warning); }
.channel-healthy { color: var(--status-success); }

/* Stepper */
.stepper {
  display: flex;
  gap: var(--space-1);
  margin: 0 0 var(--space-6);
  padding: var(--space-3);
  background: var(--background-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow-x: auto;
}
.stepper-item {
  flex: 1;
  min-width: 7rem;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
}
.stepper-item.is-current {
  background: var(--brand-primary-subtle);
  color: var(--brand-primary);
  font-weight: 600;
}
.stepper-item.is-complete { color: var(--status-success); }
.stepper-index {
  width: 22px; height: 22px;
  border-radius: 999px;
  display: inline-grid; place-items: center;
  font-size: 11px; font-weight: 700;
  border: 1.5px solid currentColor;
  flex-shrink: 0;
}
.stepper-item.is-complete .stepper-index {
  background: var(--status-success);
  border-color: var(--status-success);
  color: #fff;
}
.stepper-mobile {
  display: none;
  margin: 0 0 var(--space-5);
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
}

/* Catalog / lists */
.contract-grid {
  display: grid;
  gap: var(--space-3);
}
.contract-card {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--background-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
}
.contract-card-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
  align-items: flex-start;
}
.contract-card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  letter-spacing: -0.01em;
}
.contract-card-meta {
  display: grid;
  gap: 0.2rem;
  color: var(--text-secondary);
  font-size: 13px;
}
.contract-card-footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  justify-content: space-between;
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-default);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  text-align: left;
  padding: 0.75rem 0.55rem;
  border-bottom: 1px solid var(--border-default);
  vertical-align: top;
}
th {
  color: var(--text-muted);
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--background-surface);
}
.table-wrap table { margin: 0; }
.table-wrap th:first-child, .table-wrap td:first-child { padding-left: var(--space-4); }
.table-wrap th:last-child, .table-wrap td:last-child { padding-right: var(--space-4); }

.empty-state {
  text-align: center;
  padding: var(--space-8) var(--space-5);
  background: var(--background-surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
}
.empty-state h2 {
  font-size: 1.1rem;
  margin: 0 0 var(--space-2);
}
.empty-state p {
  color: var(--text-secondary);
  margin: 0 0 var(--space-5);
}
.flash, .toast {
  display: flex;
  gap: var(--space-2);
  align-items: flex-start;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-4);
  border: 1px solid var(--border-default);
  background: var(--background-surface);
}
.flash.is-error, .toast.is-error {
  background: var(--status-danger-bg);
  border-color: #fecaca;
  color: var(--status-danger);
}
.flash.is-success {
  background: var(--status-success-bg);
  border-color: #a7f3d0;
  color: var(--status-success);
}
.banner {
  background: var(--status-warning-bg);
  border: 1px solid #fde68a;
  color: var(--status-warning);
  padding: var(--space-3) var(--space-4);
  margin: var(--space-4) var(--space-6) 0;
  border-radius: var(--radius-md);
  max-width: 1120px;
}
.banner a { font-weight: 600; }
.banner-detail { display: inline; margin: 0 0.35rem 0 0.15rem; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
}
details.evidence { margin-top: var(--space-1); }
details.evidence summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: var(--background-muted);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}
.skeleton {
  background: linear-gradient(90deg, var(--background-muted), #f8fafc, var(--background-muted));
  background-size: 200% 100%;
  animation: shimmer 1.2s ease-in-out infinite;
  border-radius: var(--radius-sm);
  height: 1rem;
}
@keyframes shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .skeleton { animation: none; }
}

@media (max-width: 1024px) {
  .app-shell { grid-template-columns: 1fr; }
  .app-sidebar {
    position: fixed;
    left: 0; top: 0;
    transform: translateX(-105%);
    transition: transform 180ms ease;
    box-shadow: var(--shadow-md);
  }
  .app-shell.nav-open .app-sidebar { transform: translateX(0); }
  .app-shell.nav-open .sidebar-backdrop { display: block; }
  .menu-toggle { display: inline-flex; }
  .app-topbar, .app-content, .app-footer, .banner { padding-left: var(--space-4); padding-right: var(--space-4); }
}
@media (max-width: 768px) {
  .stepper { display: none; }
  .stepper-mobile { display: block; }
  .page-title, h1.page-title { font-size: 1.45rem; }
  .row-actions { justify-content: stretch; }
  .row-actions .btn, .row-actions button { flex: 1; }
  table.responsive-cards, table.responsive-cards thead, table.responsive-cards tbody,
  table.responsive-cards th, table.responsive-cards td, table.responsive-cards tr { display: block; }
  table.responsive-cards thead { position: absolute; left: -9999px; }
  table.responsive-cards tr {
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-3);
    padding: var(--space-3);
    background: var(--background-surface);
  }
  table.responsive-cards td { border: 0; padding: 0.3rem 0; }
  table.responsive-cards td::before {
    content: attr(data-label);
    display: block;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
  }
}
`;

export function primaryNav(input: {
  loggedIn: boolean;
  current?: string;
  role?: "admin" | "operator" | "viewer";
}): string {
  // Retained for call-site compatibility. Shell navigation is rendered by layout().
  if (!input.loggedIn) {
    return "";
  }
  return `<!--nav:${escapeHtml(input.current ?? "")}:${escapeHtml(input.role ?? "admin")}-->`;
}

function parseNavMeta(nav?: string): {
  current: string;
  role: "admin" | "operator" | "viewer";
  loggedIn: boolean;
} {
  if (!nav) {
    return { current: "", role: "admin", loggedIn: false };
  }
  const match = /<!--nav:([^:]*):([^>]*)-->/.exec(nav);
  if (match) {
    const role = match[2] as "admin" | "operator" | "viewer";
    return {
      current: match[1] ?? "",
      role:
        role === "operator" || role === "viewer" || role === "admin"
          ? role
          : "admin",
      loggedIn: true,
    };
  }
  if (nav.includes("Login") && !nav.includes("Catalog")) {
    return { current: "", role: "admin", loggedIn: false };
  }
  return { current: "", role: "admin", loggedIn: true };
}

function sidebarLink(
  href: string,
  label: string,
  key: string,
  current: string,
): string {
  const active = current === key ? ' aria-current="page"' : "";
  return `<a class="nav-link" href="${href}"${active}>${escapeHtml(label)}</a>`;
}

function renderSidebar(input: {
  current: string;
  role: "admin" | "operator" | "viewer";
  orgName: string;
  userLabel: string;
}): string {
  const protect =
    input.role === "viewer"
      ? ""
      : `<a class="nav-link nav-cta" href="/protect">Protect a client</a>`;
  return `
    <aside class="app-sidebar" id="app-sidebar" aria-label="Application">
      <a class="sidebar-brand" href="/catalog">
        <span class="brand-glyph" aria-hidden="true">Q</span>
        Quorum
      </a>
      <div class="org-chip" title="Organization">${escapeHtml(input.orgName)}</div>
      <nav class="sidebar-nav" aria-label="Primary">
        <div class="nav-section-label">Monitor</div>
        ${sidebarLink("/catalog", "Catalog", "catalog", input.current)}
        ${sidebarLink("/incidents", "Incidents", "incidents", input.current)}
        ${sidebarLink("/clients", "Clients", "clients", input.current)}
        ${sidebarLink("/reports", "Reports", "reports", input.current)}
        <div class="nav-section-label">Integrations</div>
        ${sidebarLink("/connectors", "Connectors", "connectors", input.current)}
        ${sidebarLink("/alerts", "Alert channels", "alerts", input.current)}
        ${sidebarLink("/workflows", "Workflows", "workflows", input.current)}
        <div class="nav-section-label">Account</div>
        ${sidebarLink("/settings", "Settings", "settings", input.current)}
        ${protect}
      </nav>
      <div class="sidebar-footer">
        <a class="nav-link" href="/network-privacy">Network &amp; privacy</a>
        <div class="sidebar-meta">${escapeHtml(input.userLabel)}</div>
        <a class="nav-link" href="/logout">Sign out</a>
      </div>
    </aside>`;
}

const SHELL_SCRIPT = `
(function () {
  var shell = document.getElementById('app-shell');
  var toggle = document.getElementById('menu-toggle');
  var backdrop = document.getElementById('sidebar-backdrop');
  if (!shell || !toggle) return;
  function close() { shell.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); }
  function open() { shell.classList.add('nav-open'); toggle.setAttribute('aria-expanded', 'true'); }
  toggle.addEventListener('click', function () {
    if (shell.classList.contains('nav-open')) close(); else open();
  });
  if (backdrop) backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });
})();
`;

export function layout(input: {
  title: string;
  body: string;
  nav?: string;
  flash?: string | null;
  flashTone?: "error" | "success";
  banner?: string | null;
  current?: string;
  role?: "admin" | "operator" | "viewer";
  loggedIn?: boolean;
  pageTitle?: string;
  orgName?: string;
  userLabel?: string;
  contentWide?: boolean;
}): string {
  const meta = parseNavMeta(input.nav);
  const loggedIn = input.loggedIn ?? meta.loggedIn;
  const current = input.current ?? meta.current;
  const role = input.role ?? meta.role;
  const pageTitle = input.pageTitle ?? input.title;
  const orgName = input.orgName ?? "Self-hosted organization";
  const userLabel = input.userLabel ?? (role === "viewer" ? "Viewer" : "Admin");
  const flashTone = input.flashTone ?? "error";

  const flashHtml = input.flash
    ? `<div class="flash ${flashTone === "success" ? "is-success" : "is-error"}" role="${flashTone === "success" ? "status" : "alert"}">${escapeHtml(input.flash)}</div>`
    : "";

  if (!loggedIn) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)} · Quorum</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="auth-shell">
    <div class="auth-card" id="main">
      <a class="brand-mark" href="/login"><span class="brand-glyph" aria-hidden="true">Q</span> Quorum</a>
      ${flashHtml}
      ${input.body}
    </div>
  </div>
</body>
</html>`;
  }

  const banner = input.banner
    ? `<div class="banner" role="status">${input.banner}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)} · Quorum</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="app-shell" id="app-shell">
    <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
    ${renderSidebar({ current, role, orgName, userLabel })}
    <div class="app-main-column">
      <header class="app-topbar">
        <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="app-sidebar">☰</button>
        <h1 class="topbar-title">${escapeHtml(pageTitle)}</h1>
        <span class="topbar-spacer"></span>
        <span class="topbar-status" title="Self-hosted edition">Self-hosted</span>
      </header>
      ${banner}
      <main id="main" class="app-content${input.contentWide ? " wide" : ""}">
        ${flashHtml}
        ${input.body}
      </main>
      <footer class="app-footer">
        Self-hosted · zero telemetry · heartbeat and volume evidence do not prove destination delivery.
      </footer>
    </div>
  </div>
  <script>${SHELL_SCRIPT}</script>
</body>
</html>`;
}

export function alertDeliveryBannerHtml(input: {
  channelName: string;
  lastFailedAt: string;
  channelId: string;
  health?: "failing" | "degraded";
}): string {
  const when = formatAlertFailureTime(input.lastFailedAt);
  const detail =
    input.health === "degraded"
      ? `<strong>${escapeHtml(input.channelName)}</strong> reported a degraded delivery attempt at ${escapeHtml(when)}.`
      : `<strong>${escapeHtml(input.channelName)}</strong> failed its latest delivery attempt at ${escapeHtml(when)}.`;
  return `<strong>Alerts may not be reaching you</strong>
    <span class="banner-detail">${detail}</span>
    <a href="/alerts/${escapeHtml(input.channelId)}">Channel details</a> ·
    <a href="/alerts/${escapeHtml(input.channelId)}/test">Send test</a>`;
}

function formatAlertFailureTime(isoOrUnknown: string): string {
  if (!isoOrUnknown || isoOrUnknown === "unknown") {
    return "an unknown time";
  }
  const ms = Date.parse(isoOrUnknown);
  if (!Number.isFinite(ms)) {
    return isoOrUnknown;
  }
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function renderStepper(input: {
  steps: Array<{ id: string; label: string }>;
  currentId: string;
}): string {
  const currentIndex = input.steps.findIndex((s) => s.id === input.currentId);
  const mobile = `Step ${Math.max(currentIndex, 0) + 1} of ${input.steps.length}: ${escapeHtml(
    input.steps[Math.max(currentIndex, 0)]?.label ?? "",
  )}`;
  const items = input.steps
    .map((step, index) => {
      const complete = currentIndex > index;
      const current = step.id === input.currentId;
      const cls = [
        "stepper-item",
        current ? "is-current" : "",
        complete ? "is-complete" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const indexLabel = complete ? "✓" : String(index + 1);
      const aria = current
        ? ' aria-current="step"'
        : complete
          ? ' data-complete="true"'
          : "";
      return `<div class="${cls}"${aria}>
        <span class="stepper-index" aria-hidden="true">${indexLabel}</span>
        <span>${escapeHtml(step.label)}</span>
      </div>`;
    })
    .join("");
  return `<div class="stepper-mobile" aria-live="polite">${mobile}</div>
    <nav class="stepper" aria-label="Setup progress">${items}</nav>`;
}

export function statusBadge(health: string): string {
  const map: Record<string, { label: string; cls: string }> = {
    healthy: { label: "Healthy", cls: "badge-status-healthy" },
    warning: { label: "Waiting", cls: "badge-status-waiting" },
    overdue: { label: "Overdue", cls: "badge-status-overdue" },
    unknown: { label: "Unknown", cls: "badge-status-unknown" },
    inactive: { label: "Paused", cls: "badge-status-paused" },
  };
  const item = map[health] ?? { label: health, cls: "badge-status-unknown" };
  return `<span class="badge ${item.cls}"><span class="sr-only">Health: </span>${escapeHtml(item.label)}</span>`;
}

export function evidenceBadge(level: string, stale = false): string {
  const labels: Record<string, string> = {
    basic: "Basic evidence",
    medium: "Medium evidence",
    high: "High evidence",
  };
  const label = labels[level] ?? `${level} evidence`;
  return `<span class="badge badge-evidence-${escapeHtml(level)}" aria-label="Evidence level ${escapeHtml(level)}${stale ? ", stale" : ""}">${escapeHtml(label)}${stale ? " (stale)" : ""}</span>`;
}
