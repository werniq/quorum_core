import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { Clock } from "../../../domain/clock.js";
import {
  applyCatalogFilters,
  summarizeCatalog,
} from "../../../domain/catalog/summary.js";
import {
  deriveClientProtectionStatus,
  summarizeClientCoverage,
} from "../../../domain/clients/protection-status.js";
import {
  evidenceRaiseConfidenceHint,
  plainUnverifiedLabels,
  plainVerifiedLabels,
} from "../../../domain/catalog/evidence-explanation.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../../domain/evidence/unverified-dimensions.js";
import { queryContractCatalog } from "../../catalog/query-catalog.js";
import { queryVolumeCatalogSummary } from "../../catalog/volume-catalog.js";
import type { QuorumEnv } from "../../config/env.js";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { SqliteCoreRepositories } from "../../db/repositories/sqlite-core-repositories.js";
import {
  alertDeliveryBannerHtml,
  escapeHtml,
} from "../../../presentation/html/layout.js";
import {
  renderCatalogPage,
  renderClientHealthPage,
  renderClientsPage,
  renderSimpleNavPage,
  renderWorkflowContractDetailPage,
} from "../../../presentation/html/catalog-ui.js";
import { renderIncidentsPage } from "../../../presentation/html/incidents-ui.js";
import type { IncidentListRow } from "../../../presentation/html/incidents-ui.js";
import { SILENT_ABSENCE_MESSAGE } from "../../../domain/n8n/workflow-editor-url.js";
import { formatHeartbeatHistoryRow } from "../../../domain/incidents/hard-failure.js";
import { createId } from "../../../domain/ids.js";
import { toCatalogRowView } from "./catalog-row-view.js";
import type { createOutboxProcessor } from "../../alerting/process-outbox.js";

type Session = {
  adminUserId: string;
  csrfToken: string;
  role: "admin" | "operator" | "viewer";
};

export function registerProductUiRoutes(
  app: FastifyInstance,
  deps: {
    env: QuorumEnv;
    sqlite: Database.Database;
    clock: Clock;
    processOutbox?: ReturnType<typeof createOutboxProcessor>;
    getWatcherHealth?: () => {
      lastSuccessAt: string | null;
      staleAfterMs: number;
      nowMs: number;
    };
    requireSession: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Session | null;
    assertCsrf: (
      request: FastifyRequest,
      session: Session,
      reply: FastifyReply,
    ) => boolean;
    tenantId: () => string;
  },
): void {
  const pageShell = { demoMode: deps.env.QUORUM_DEMO_MODE };
  const core = new SqliteCoreRepositories(deps.sqlite);
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  function requireAdmin(session: Session, reply: FastifyReply): boolean {
    if (session.role === "viewer") {
      void reply
        .code(403)
        .type("text/html")
        .send("Viewer role cannot mutate contracts or settings.");
      return false;
    }
    return true;
  }

  function failingBanner(tid: string): string | null {
    // Organization-level: any active channel that is failing or degraded.
    const failing = deps.sqlite
      .prepare(
        `SELECT c.id, c.name, s.current_health, s.last_failure_at
         FROM alert_channels c
         JOIN alert_channel_states s
           ON s.tenant_id = c.tenant_id AND s.alert_channel_id = c.id
         WHERE c.tenant_id = ?
           AND c.is_active = 1
           AND s.current_health IN ('failing', 'degraded')
         ORDER BY
           CASE s.current_health WHEN 'failing' THEN 0 ELSE 1 END,
           CASE WHEN s.last_failure_at IS NULL THEN 1 ELSE 0 END,
           s.last_failure_at DESC
         LIMIT 1`,
      )
      .get(tid) as
      | {
          id: string;
          name: string;
          current_health: string;
          last_failure_at: string | null;
        }
      | undefined;
    if (!failing) {
      return null;
    }
    return alertDeliveryBannerHtml({
      channelName: failing.name,
      lastFailedAt: failing.last_failure_at ?? "unknown",
      channelId: failing.id,
      health: failing.current_health === "degraded" ? "degraded" : "failing",
    });
  }

  function loadCatalogViews(tid: string, clientId?: string | null) {
    return queryContractCatalog({
      sqlite: deps.sqlite,
      clock: deps.clock,
      tenantId: tid,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
      clientId: clientId ?? null,
    }).map(toCatalogRowView);
  }

  app.get("/catalog", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const q = request.query as Record<string, string | undefined>;
    const filters = {
      clientId: q.clientId || null,
      health: q.health || null,
      evidenceLevel: q.evidenceLevel || null,
      contractKind: q.contractKind || null,
      connectorHealth: q.connectorHealth || null,
      alertChannelHealth: q.alertChannelHealth || null,
    };
    const all = loadCatalogViews(tid);
    const filtered = applyCatalogFilters(all, filters).map((r) => r);
    const processWatchdogHealth =
      all.find((c) => c.processWatchdogHealth === "stale")
        ?.processWatchdogHealth ??
      all[0]?.processWatchdogHealth ??
      "not_evaluated";
    const flashRaw = q.flash ? String(q.flash) : null;
    return reply.type("text/html").send(
      renderCatalogPage({
        ...pageShell,
        csrf: session.csrfToken,
        role: session.role,
        contracts: filtered,
        summary: summarizeCatalog(all),
        clients: core.listClients(tid).map((c) => ({ id: c.id, name: c.name })),
        filters: Object.fromEntries(
          Object.entries(filters).map(([k, v]) => [k, v ?? ""]),
        ),
        flash: flashRaw,
        flashTone: flashRaw?.startsWith("Watchdog ok") ? "success" : "error",
        banner: failingBanner(tid),
        processWatchdogHealth,
      }),
    );
  });

  app.post("/catalog/watchdog-test", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session || !requireAdmin(session, reply)) {
      return;
    }
    if (!deps.assertCsrf(request, session, reply)) {
      return;
    }
    // Read-only probe: never opens incidents or mutates workflow/contract state.
    const health = deps.getWatcherHealth
      ? deps.getWatcherHealth()
      : {
          lastSuccessAt: null as string | null,
          staleAfterMs: 180_000,
          nowMs: deps.clock.now().getTime(),
        };
    let flash: string;
    if (!health.lastSuccessAt) {
      flash = "Watchdog stale (never succeeded)";
    } else {
      const ageMs = health.nowMs - new Date(health.lastSuccessAt).getTime();
      if (ageMs > health.staleAfterMs) {
        flash = `Watchdog stale (age ${Math.round(ageMs / 1000)}s)`;
      } else {
        flash = `Watchdog ok (age ${Math.round(ageMs / 1000)}s)`;
      }
    }
    return reply.redirect(`/catalog?flash=${encodeURIComponent(flash)}`);
  });

  // Canonical setup UI is /onboarding. POST /protect/* stays in ui-protect-compat-routes
  // for verification scripts; GET redirects here.
  app.get("/protect", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session || !requireAdmin(session, reply)) {
      return;
    }
    return reply.redirect("/onboarding");
  });

  app.get("/clients", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const removed = (request.query as { removed?: string }).removed;
    const flash =
      removed === "1"
        ? `<p class="ok" role="status">Client removed. Related workflows were stopped; historical evidence is kept.</p>`
        : "";
    const catalog = loadCatalogViews(tid);
    const clients = core
      .listClients(tid)
      .filter((c) => c.status !== "archived")
      .map((c) => {
        const rows = catalog.filter((r) => r.clientId === c.id);
        const activeWithAlert = rows.filter(
          (r) =>
            r.isActive &&
            (r.alertChannelHealth === "healthy" ||
              r.alertChannelHealth === "degraded"),
        ).length;
        const status =
          c.status === "archived"
            ? "archived"
            : deriveClientProtectionStatus({
                hasAnyContract: rows.length > 0,
                activeContractsWithTestedAlert: activeWithAlert,
                allContractsPaused:
                  rows.length > 0 && rows.every((r) => !r.isActive),
                archived: false,
              });
        const coverage = summarizeClientCoverage(rows, status);
        return {
          id: c.id,
          name: c.name,
          status: coverage.status,
          coverageNote: coverage.coverageNote,
        };
      });
    return reply.type("text/html").send(
      renderClientsPage({
        ...pageShell,
        role: session.role,
        csrf: session.csrfToken,
        flash,
        clients,
      }),
    );
  });

  app.get("/clients/:clientId", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const clientId = (request.params as { clientId: string }).clientId;
    const tid = deps.tenantId();
    const client = core.getClient(tid, clientId);
    if (!client) {
      return reply.code(404).type("text/html").send("Client not found");
    }
    const contracts = loadCatalogViews(tid, clientId);
    const activeWithAlert = contracts.filter(
      (r) =>
        r.isActive &&
        (r.alertChannelHealth === "healthy" ||
          r.alertChannelHealth === "degraded"),
    ).length;
    const status = deriveClientProtectionStatus({
      hasAnyContract: contracts.length > 0,
      activeContractsWithTestedAlert: activeWithAlert,
      allContractsPaused:
        contracts.length > 0 && contracts.every((r) => !r.isActive),
      archived: client.status === "archived",
    });
    const coverage = summarizeClientCoverage(contracts, status);
    return reply.type("text/html").send(
      renderClientHealthPage({
        ...pageShell,
        role: session.role,
        clientName: client.name,
        status: coverage.status,
        coverageNote: coverage.coverageNote,
        monitoringPeriod: client.protectionStartedAt
          ? `since ${client.protectionStartedAt}`
          : "not started",
        contracts,
      }),
    );
  });

  app.get("/incidents", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const resolvedAfter = new Date(
      deps.clock.now().getTime() - 24 * 60 * 60_000,
    ).toISOString();
    const rawRows = deps.sqlite
      .prepare(
        `SELECT
           i.id,
           i.severity,
           i.status,
           i.summary,
           i.opened_at,
           i.resolved_at,
           i.details_json,
           i.incident_type,
           i.workflow_id,
           w.name AS workflow_name,
           w.monitoring_method,
           w.external_workflow_id,
           s.last_acceptable_success_at,
           s.next_expected_at,
           s.overdue_since,
           nc.base_url AS connector_base_url
         FROM incidents i
         LEFT JOIN workflows w
           ON w.id = i.workflow_id AND w.tenant_id = i.tenant_id
         LEFT JOIN workflow_states s
           ON s.workflow_id = i.workflow_id AND s.tenant_id = i.tenant_id
         LEFT JOIN n8n_connectors nc
           ON nc.id = w.connector_id AND nc.tenant_id = w.tenant_id
         WHERE i.tenant_id = ?
           AND (
             i.status IN ('open', 'acknowledged')
             OR (
               i.incident_type = 'hard_failure'
               AND i.status = 'resolved'
               AND i.resolved_at IS NOT NULL
               AND i.resolved_at >= ?
             )
           )
         ORDER BY
           CASE i.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
           i.opened_at DESC
         LIMIT 100`,
      )
      .all(tid, resolvedAfter) as Array<{
      id: string;
      severity: string;
      status: string;
      summary: string;
      opened_at: string;
      resolved_at: string | null;
      details_json: string | null;
      incident_type: string;
      workflow_id: string | null;
      workflow_name: string | null;
      monitoring_method: string | null;
      external_workflow_id: string | null;
      last_acceptable_success_at: string | null;
      next_expected_at: string | null;
      overdue_since: string | null;
      connector_base_url: string | null;
    }>;

    const rows: IncidentListRow[] = rawRows.map((r) => ({
      id: r.id,
      severity: r.severity,
      status: r.status,
      summary:
        r.incident_type === "silent_absence"
          ? SILENT_ABSENCE_MESSAGE
          : r.summary,
      openedAt: r.opened_at,
      resolvedAt: r.resolved_at,
      detailsJson: r.details_json,
      incidentType: r.incident_type,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      monitoringMethod:
        r.monitoring_method === "poll" || r.monitoring_method === "push"
          ? r.monitoring_method
          : null,
      externalWorkflowId: r.external_workflow_id,
      connectorBaseUrl: r.connector_base_url,
      lastAcceptableEvidenceAt: r.last_acceptable_success_at,
      nextExpectedAt: r.next_expected_at,
      overdueSince: r.overdue_since,
    }));

    const attention = deps.sqlite
      .prepare(
        `SELECT
           SUM(CASE WHEN s.current_health = 'warning' THEN 1 ELSE 0 END) AS warning_count,
           SUM(CASE WHEN s.current_health = 'overdue' THEN 1 ELSE 0 END) AS overdue_count
         FROM workflow_contracts c
         JOIN workflows w ON w.id = c.workflow_id AND w.tenant_id = c.tenant_id
         JOIN workflow_states s ON s.workflow_id = c.workflow_id AND s.tenant_id = c.tenant_id
         WHERE c.tenant_id = ?
           AND c.contract_type = 'heartbeat'
           AND c.is_active = 1
           AND w.is_active = 1
           AND IFNULL(w.description, '') != '__quorum_removed__'`,
      )
      .get(tid) as
      | { warning_count: number | null; overdue_count: number | null }
      | undefined;
    const warningCount = Number(attention?.warning_count ?? 0);
    const overdueCount = Number(attention?.overdue_count ?? 0);
    const attentionCount = warningCount + overdueCount;
    const flash =
      (request.query as { acknowledged?: string }).acknowledged === "1"
        ? "Incident acknowledged."
        : null;

    return reply.type("text/html").send(
      renderIncidentsPage({
        ...pageShell,
        role: session.role,
        csrf: session.csrfToken,
        rows,
        nowMs: deps.clock.now().getTime(),
        attentionCount,
        warningCount,
        overdueCount,
        flash,
      }),
    );
  });

  app.post("/incidents/:incidentId/acknowledge", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session || !requireAdmin(session, reply)) {
      return;
    }
    if (!deps.assertCsrf(request, session, reply)) {
      return;
    }
    const incidentId = (request.params as { incidentId: string }).incidentId;
    const tid = deps.tenantId();
    try {
      alerting.acknowledgeIncident(tid, incidentId, {
        actor: session.adminUserId,
        at: deps.clock.now().toISOString(),
      });
      alerting.enqueueOutbox(tid, {
        id: createId(),
        incidentId,
        eventType: "acknowledged",
        payloadJson: JSON.stringify({ incidentId }),
        availableAt: deps.clock.now().toISOString(),
      });
    } catch {
      return reply.redirect("/incidents");
    }
    return reply.redirect("/incidents?acknowledged=1");
  });

  app.get("/reports", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: "Reports",
        current: "reports",
        role: session.role,
        body: `<h1>Reports</h1>
          <p class="muted">Open a client health view for coverage and evidence without overstating protection.</p>
          <p><a href="/clients">Browse clients</a></p>`,
      }),
    );
  });

  app.get("/connectors", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const q = request.query as { tested?: string; removed?: string };
    const tested = q.tested;
    const removed = q.removed;
    const flash =
      tested === "ok"
        ? `<p class="ok" role="status">Connector test succeeded.</p>`
        : tested === "fail"
          ? `<p class="err" role="alert">Connector test failed. Check health below.</p>`
          : removed === "1"
            ? `<p class="ok" role="status">Connector removed.</p>`
            : "";
    const rows = deps.sqlite
      .prepare(
        `SELECT id, name, status AS health, provider AS kind, status AS connector_status
         FROM connectors WHERE tenant_id = ?
         UNION ALL
         SELECT id, name, health, 'n8n' AS kind, status AS connector_status
         FROM n8n_connectors WHERE tenant_id = ?`,
      )
      .all(tid, tid) as Array<{
      id: string;
      name: string;
      health: string;
      kind: string;
      connector_status: string;
    }>;
    const createForm = `<form method="post" action="/connectors/n8n" class="card stack">
        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
        <h2 class="card-title">Add n8n connector</h2>
        <label class="field">Name<input name="name" required value="n8n" /></label>
        <label class="field">Base URL<input name="baseUrl" required placeholder="http://127.0.0.1:5678" value="http://127.0.0.1:5678" /></label>
        <label class="field">API key<input name="apiKey" type="password" required autocomplete="off" /></label>
        <div class="row-actions"><button type="submit">Create connector</button></div>
      </form>`;
    const table =
      rows.length === 0
        ? `<div class="empty-state"><h2>No connectors yet</h2><p>Create an n8n connector to poll workflow executions.</p></div>`
        : `<div class="card table-wrap" style="padding:0"><table class="responsive-cards">
            <thead><tr><th>Name</th><th>Kind</th><th>Health</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows
              .map((r) => {
                const actions =
                  r.kind === "n8n"
                    ? `<div class="stack-sm workflow-actions" style="min-width:0;max-width:14rem">
                      <form method="post" action="/connectors/n8n/${escapeHtml(r.id)}/test">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                        <button type="submit" class="btn-secondary" style="width:100%">Test connection</button>
                      </form>
                      ${
                        r.connector_status === "active"
                          ? `<form method="post" action="/connectors/n8n/${escapeHtml(r.id)}/disable">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                        <button type="submit" class="btn-ghost" style="width:100%">Disable</button>
                      </form>`
                          : ""
                      }
                      <form method="post" action="/connectors/n8n/${escapeHtml(r.id)}/delete" onsubmit="return confirm('Remove this n8n connector? Workflows bound to it will be unbound.');">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                        <button type="submit" class="btn-ghost" style="width:100%">Remove</button>
                      </form>
                    </div>`
                    : "";
                return `<tr>
                  <td data-label="Name">${escapeHtml(r.name)}</td>
                  <td data-label="Kind">${escapeHtml(r.kind)}</td>
                  <td data-label="Health" class="health-${escapeHtml(r.health)}"><strong>${escapeHtml(r.health)}</strong></td>
                  <td data-label="Status">${escapeHtml(r.connector_status)}</td>
                  <td data-label="Actions">${actions}</td>
                </tr>`;
              })
              .join("")}</tbody></table></div>`;
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: "Connectors",
        current: "connectors",
        role: session.role,
        body: `<h1 class="page-title">Connectors</h1><p class="page-subtitle">Connect Quorum to n8n and supported outcome systems.</p>${flash}${createForm}${table}`,
      }),
    );
  });

  app.get("/settings", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: "Settings",
        current: "settings",
        role: session.role,
        body: `<h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Workspace preferences and setup paths.</p>
          <div class="card stack">
            <a href="/network-privacy">Network and privacy</a>
            <a href="/onboarding">Setup wizard</a>
            <a href="/workflows">Workflow registration</a>
          </div>
          <p class="helper">Role: ${escapeHtml(session.role)}. Viewers cannot mutate contracts.</p>`,
      }),
    );
  });

  app.get("/catalog/contracts/:workflowId", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const workflowId = (request.params as { workflowId: string }).workflowId;
    const tid = deps.tenantId();
    const catalog = loadCatalogViews(tid);
    const row = catalog.find((c) => c.workflowId === workflowId);
    if (!row) {
      return reply.code(404).type("text/html").send("Contract not found");
    }
    const contract = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_contracts WHERE tenant_id = ? AND workflow_id = ? AND contract_type = 'heartbeat' LIMIT 1`,
      )
      .get(tid, workflowId) as Record<string, unknown> | undefined;
    const incidents = deps.sqlite
      .prepare(
        `SELECT summary, status, severity FROM incidents
         WHERE tenant_id = ? AND workflow_id = ?
         ORDER BY opened_at DESC LIMIT 10`,
      )
      .all(tid, workflowId) as Array<{
      summary: string;
      status: string;
      severity: string;
    }>;
    const channels = deps.sqlite
      .prepare(
        `SELECT c.name, COALESCE(s.current_health, 'unknown') AS health
         FROM contract_alert_channels r
         JOIN alert_channels c ON c.id = r.alert_channel_id AND c.tenant_id = r.tenant_id
         LEFT JOIN alert_channel_states s ON s.alert_channel_id = c.id AND s.tenant_id = c.tenant_id
         WHERE r.tenant_id = ? AND r.contract_kind = 'workflow' AND r.contract_id = ?`,
      )
      .all(tid, row.contractId) as Array<{ name: string; health: string }>;
    const events = deps.sqlite
      .prepare(
        `SELECT received_at AS at, status, items_processed
         FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ?
         ORDER BY received_at DESC LIMIT 8`,
      )
      .all(tid, workflowId) as Array<{
      at: string;
      status: string;
      items_processed: number | null;
    }>;

    const volume = queryVolumeCatalogSummary({
      sqlite: deps.sqlite,
      clock: deps.clock,
      tenantId: tid,
      workflowContractId: row.contractId,
      workflowId,
    });

    return reply.type("text/html").send(
      renderWorkflowContractDetailPage({
        ...pageShell,
        role: session.role,
        csrf: session.csrfToken,
        contract: {
          name: String(contract?.name ?? row.businessPurposeName),
          businessPurpose: row.businessPurposeName,
          cadence: row.expectedCadenceOrWindow,
          isActive: row.isActive,
          evidenceLevel: row.evidenceLevel,
          health: row.health,
          lastEvidence: row.lastAcceptableEvidenceAt,
          nextDeadline: row.nextDeadlineAt,
          verified: plainVerifiedLabels(row.evidenceLevel),
          unverified: plainUnverifiedLabels(
            unverifiedDimensionsForEvidenceLevel(row.evidenceLevel),
          ),
          raiseHint: evidenceRaiseConfidenceHint(row.evidenceLevel),
        },
        incidents,
        channels,
        recentEvents: events.map((e) => ({
          at: e.at,
          label: formatHeartbeatHistoryRow({
            at: e.at,
            status: e.status,
            itemsProcessed: e.items_processed,
          }),
        })),
        volume: volume
          ? {
              label: volume.label,
              expectedRange: volume.expectedRange,
              currentCount: volume.currentCount,
              windowEndsLabel: volume.windowEndsLabel,
              status: volume.status,
              unknownCountEvents: volume.unknownCountEvents,
              verified: volume.verified,
              unverified: volume.unverified,
            }
          : null,
      }),
    );
  });

  app.get("/alerts/:channelId", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const channelId = (request.params as { channelId: string }).channelId;
    const tid = deps.tenantId();
    const channel = alerting.getAlertChannel(tid, channelId);
    if (!channel) {
      return reply.code(404).type("text/html").send("Channel not found");
    }
    const state = alerting.getAlertChannelState(tid, channelId);
    const attempts = alerting.listNotificationAttemptsForChannel(
      tid,
      channelId,
      40,
    );
    const timeline =
      attempts.length === 0
        ? `<p class="muted">No delivery attempts yet.</p>`
        : `<ol reversed>${attempts
            .map(
              (a) =>
                `<li><time datetime="${escapeHtml(a.attemptedAt)}">${escapeHtml(a.attemptedAt)}</time>
                  — ${escapeHtml(a.status)}
                  ${a.responseStatusCode != null ? ` · HTTP ${a.responseStatusCode}` : ""}
                  ${a.errorCode ? ` · ${escapeHtml(a.errorCode)}` : ""}
                  ${
                    a.errorMessageSanitized
                      ? `<div class="muted">${escapeHtml(a.errorMessageSanitized)}</div>`
                      : ""
                  }</li>`,
            )
            .join("")}</ol>`;
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: channel.name,
        current: "alerts",
        role: session.role,
        body: `<h1>${escapeHtml(channel.name)}</h1>
          <p>Health: <span class="channel-${escapeHtml(state?.currentHealth ?? "unknown")}">${escapeHtml(state?.currentHealth ?? "unknown")}</span></p>
          <p class="muted">Last failure: ${escapeHtml(state?.lastFailureAt ?? "none")}</p>
          <p class="muted">Last success: ${escapeHtml(state?.lastSuccessAt ?? "none")}</p>
          <p class="muted">Last error: ${escapeHtml(state?.lastErrorMessageSanitized ?? state?.lastErrorCode ?? "none")}</p>
          <p class="muted">Delivery failures do not change the underlying incident truth — only notification path health.</p>
          ${
            session.role !== "viewer"
              ? `<form method="post" action="/alerts/${escapeHtml(channelId)}/test">
                   <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                   <button type="submit">Send test</button>
                 </form>`
              : ""
          }
          <h2>Attempt timeline</h2>
          ${timeline}
          <p><a href="/alerts">Back to alert channels</a></p>`,
      }),
    );
  });

  /** Deep-link target from alert-delivery banner “Send test”. */
  app.get("/alerts/:channelId/test", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const channelId = (request.params as { channelId: string }).channelId;
    if (session.role === "viewer") {
      return reply.redirect(`/alerts/${channelId}`);
    }
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: "Send test",
        current: "alerts",
        role: session.role,
        body: `<h1>Send test alert</h1>
          <form method="post" action="/alerts/${channelId}/test" class="card">
            <input type="hidden" name="csrf" value="${session.csrfToken}" />
            <button type="submit">Send test</button>
          </form>
          <p><a href="/alerts/${channelId}">Cancel</a></p>`,
      }),
    );
  });
}
