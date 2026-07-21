import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { Clock } from "../../../domain/clock.js";
import { assertExplicitContractConfirmation } from "../../../domain/contracts/explicit-activation.js";
import { validateWorkflowContract } from "../../../domain/contracts/validate-workflow-contract.js";
import { createId } from "../../../domain/ids.js";
import {
  applyCatalogFilters,
  summarizeCatalog,
} from "../../../domain/catalog/summary.js";
import { getProcessTemplate } from "../../../domain/catalog/process-templates.js";
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
import { SqliteOpsAuditRepositories } from "../../db/repositories/sqlite-ops-audit-repositories.js";
import { SqliteOutboundDestinationRepositories } from "../../db/repositories/sqlite-outbound-destinations.js";
import { encryptCredentialSecret } from "../../security/credential-secrets.js";
import {
  validateWorkflowRegistrationInput,
  workflowRegistrationErrorMessage,
} from "../ui-form-errors.js";
import {
  alertDeliveryBannerHtml,
  escapeHtml,
} from "../../../presentation/html/layout.js";
import {
  renderCatalogPage,
  renderClientHealthPage,
  renderClientsPage,
  renderProtectClientPage,
  renderSimpleNavPage,
  renderWorkflowContractDetailPage,
} from "../../../presentation/html/catalog-ui.js";
import { toCatalogRowView } from "./catalog-row-view.js";
import type { createOutboxProcessor } from "../../alerting/process-outbox.js";

type Session = {
  adminUserId: string;
  csrfToken: string;
  role: "admin" | "operator" | "viewer";
};

function formBody(request: FastifyRequest): Record<string, string> {
  const body = request.body;
  if (!body || typeof body !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (typeof value === "boolean" || typeof value === "number") {
      out[key] = String(value);
    }
  }
  return out;
}

function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `client-${createId().slice(0, 8)}`
  );
}

export function registerProductUiRoutes(
  app: FastifyInstance,
  deps: {
    env: QuorumEnv;
    sqlite: Database.Database;
    clock: Clock;
    processOutbox?: ReturnType<typeof createOutboxProcessor>;
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
  const outbound = new SqliteOutboundDestinationRepositories(deps.sqlite);
  const opsAudit = new SqliteOpsAuditRepositories(deps.sqlite);

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
        banner: failingBanner(tid),
      }),
    );
  });

  app.get("/protect", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session || !requireAdmin(session, reply)) {
      return;
    }
    const tid = deps.tenantId();
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 1,
        clients: core.listClients(tid).map((c) => ({ id: c.id, name: c.name })),
      }),
    );
  });

  app.post("/protect/client", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    let clientId = body.clientId ?? "";
    if (!clientId) {
      const name = (body.newClientName ?? "").trim() || "New client";
      const client = core.createClient(tid, {
        id: createId(),
        name,
        slug: slugFromName(name),
        status: "onboarding",
        protectionStartedAt: null,
      });
      clientId = client.id;
    }
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 2,
        clients: core.listClients(tid).map((c) => ({ id: c.id, name: c.name })),
        draft: { clientId },
      }),
    );
  });

  app.post("/protect/process", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const template = getProcessTemplate(body.templateId ?? "custom");
    const purpose =
      (body.businessPurpose ?? "").trim() ||
      template?.suggestedPurpose ||
      "Critical business process";
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 3,
        clients: [],
        draft: {
          clientId: body.clientId ?? "",
          templateId: body.templateId ?? "custom",
          businessPurpose: purpose,
          cadenceValue:
            template && "suggestedCadenceValue" in template
              ? String(template.suggestedCadenceValue ?? "15")
              : "15",
        },
      }),
    );
  });

  app.post("/protect/workflow", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const clients = core.listClients(tid).map((c) => ({
      id: c.id,
      name: c.name,
    }));
    const workflowName = (body.workflowName ?? "").trim();
    const externalWorkflowId = (body.externalWorkflowId ?? "").trim();
    const monitoringMethod = body.monitoringMethod === "poll" ? "poll" : "push";
    const draft = {
      clientId: body.clientId ?? "",
      templateId: body.templateId ?? "",
      businessPurpose: body.businessPurpose ?? "",
      cadenceValue: body.cadenceValue ?? "15",
      workflowName,
      externalWorkflowId,
      monitoringMethod,
    };
    const validationError = validateWorkflowRegistrationInput({
      name: workflowName,
      externalWorkflowId,
    });
    if (validationError) {
      return reply
        .code(400)
        .type("text/html")
        .send(
          renderProtectClientPage({
        ...pageShell,
            csrf: session.csrfToken,
            step: 3,
            clients,
            flash: validationError,
            draft,
          }),
        );
    }
    let workflow;
    try {
      workflow = core.createWorkflow(tid, {
        id: createId(),
        clientId: body.clientId || null,
        name: workflowName,
        externalWorkflowId,
        description: null,
        monitoringMethod,
        isActive: false,
        monitoringStartedAt: null,
      });
    } catch (error) {
      return reply
        .code(400)
        .type("text/html")
        .send(
          renderProtectClientPage({
        ...pageShell,
            csrf: session.csrfToken,
            step: 3,
            clients,
            flash: workflowRegistrationErrorMessage(error),
            draft,
          }),
        );
    }
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 4,
        clients,
        flash: "Workflow registered. Define the monitoring contract next.",
        flashTone: "success",
        draft: {
          ...draft,
          workflowId: workflow.id,
        },
      }),
    );
  });

  app.post("/protect/contract", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    try {
      assertExplicitContractConfirmation(
        body.explicitlyConfirmed === "1",
        "alter",
      );
    } catch {
      return reply.type("text/html").send(
        renderProtectClientPage({
        ...pageShell,
          csrf: session.csrfToken,
          step: 4,
          clients: [],
          flash:
            "Explicit cadence confirmation is required — templates never auto-activate.",
          draft: body,
        }),
      );
    }
    if (body.evidenceAcknowledged !== "1") {
      return reply.type("text/html").send(
        renderProtectClientPage({
        ...pageShell,
          csrf: session.csrfToken,
          step: 4,
          clients: [],
          flash: "Acknowledge evidence limitations before saving.",
          draft: body,
        }),
      );
    }
    const tid = deps.tenantId();
    const cadenceType =
      body.cadenceType === "cron" || body.cadenceType === "event_driven"
        ? body.cadenceType
        : "interval";
    const contract = core.createWorkflowContract(tid, {
      id: createId(),
      workflowId: body.workflowId ?? "",
      name: body.name ?? "Contract",
      businessPurpose: body.businessPurpose ?? "",
      cadenceType,
      cadenceValue: body.cadenceValue ?? "15",
      intervalMode: cadenceType === "interval" ? "fixed_rate" : null,
      scheduleAnchorAt:
        cadenceType === "interval" ? deps.clock.now().toISOString() : null,
      timezone: body.timezone || "UTC",
      allowedLatenessMinutes: 5,
      maxQuietWindowMinutes: cadenceType === "event_driven" ? 60 : null,
      initialGraceMinutes: 5,
      emptyResultPolicy: "allowed",
      countLessSuccessAllowed: true,
      notificationBackoffMinutes: 30,
      evidenceLevel: "basic",
      schemaVersion: 1,
      isActive: false,
      activatedAt: null,
    });
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "contract.created",
      resourceType: "workflow_contract",
      resourceId: contract.id,
      details: { cadenceType, cadenceValue: body.cadenceValue ?? "15" },
      nowIso: deps.clock.now().toISOString(),
    });
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 5,
        clients: [],
        draft: {
          clientId: body.clientId ?? "",
          workflowId: body.workflowId ?? "",
          contractId: contract.id,
        },
      }),
    );
  });

  app.post("/protect/alerts", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const channelId = createId();
    const url = body.url ?? "";
    alerting.createAlertChannel(tid, {
      id: channelId,
      name: body.channelName ?? "Ops webhook",
      type: "webhook",
      encryptedConfig: encryptCredentialSecret(
        JSON.stringify({ url }),
        deps.env.QUORUM_CREDENTIAL_KEK,
      ),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    outbound.upsertDestination({
      tenantId: tid,
      kind: "webhook",
      label: body.channelName ?? "Ops webhook",
      destination: url,
      nowIso,
    });
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "alert_channel.created",
      resourceType: "alert_channel",
      resourceId: channelId,
      details: { type: "webhook", name: body.channelName ?? "Ops webhook" },
      nowIso,
    });
    if (body.contractId) {
      alerting.routeContractToChannel(tid, {
        contractKind: "workflow",
        contractId: body.contractId,
        alertChannelId: channelId,
      });
    }
    const outboxId = createId();
    alerting.enqueueOutbox(tid, {
      id: outboxId,
      incidentId: null,
      eventType: "channel_test",
      payloadJson: JSON.stringify({ alertChannelId: channelId }),
      availableAt: nowIso,
    });
    if (deps.processOutbox) {
      await deps.processOutbox.processBatch(10);
    } else {
      alerting.applyChannelDeliveryResult(
        tid,
        channelId,
        { type: "test_succeeded" },
        nowIso,
      );
      alerting.markOutboxProcessed(tid, outboxId, nowIso);
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "alert_channel.tested",
      resourceType: "alert_channel",
      resourceId: channelId,
      nowIso,
    });
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step: 6,
        clients: [],
        draft: {
          clientId: body.clientId ?? "",
          workflowId: body.workflowId ?? "",
          contractId: body.contractId ?? "",
          channelId,
        },
      }),
    );
  });

  app.post("/protect/activate", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    try {
      assertExplicitContractConfirmation(
        body.explicitlyConfirmed === "1",
        "activate",
      );
    } catch {
      return reply.type("text/html").send(
        renderProtectClientPage({
        ...pageShell,
          csrf: session.csrfToken,
          step: 6,
          clients: [],
          flash: "Activation requires explicit confirmation.",
          draft: body,
        }),
      );
    }
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const contractId = body.contractId ?? "";
    const contractRow = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_contracts WHERE tenant_id = ? AND id = ?`,
      )
      .get(tid, contractId) as Record<string, unknown> | undefined;
    if (!contractRow) {
      return reply.code(404).type("text/html").send("Contract not found");
    }
    const routes = alerting.listRoutesForContract(tid, "workflow", contractId);
    const testedRoute = routes.some((r) => {
      const state = alerting.getAlertChannelState(tid, r.alertChannelId);
      return (
        state?.currentHealth === "healthy" ||
        state?.lastSuccessAt != null ||
        state?.lastTestedAt != null
      );
    });
    const acknowledgedNoAlertMode = body.acknowledgedNoAlertMode === "1";
    const validation = validateWorkflowContract(
      {
        workflowId: String(contractRow.workflow_id),
        name: String(contractRow.name),
        businessPurpose: String(contractRow.business_purpose),
        contractType: "heartbeat",
        cadenceType: contractRow.cadence_type as
          | "interval"
          | "cron"
          | "event_driven",
        cadenceValue: String(contractRow.cadence_value),
        intervalMode:
          (contractRow.interval_mode as
            | "fixed_rate"
            | "since_last_success"
            | null) ?? null,
        scheduleAnchorAt: contractRow.schedule_anchor_at
          ? new Date(String(contractRow.schedule_anchor_at))
          : null,
        timezone: String(contractRow.timezone),
        allowedLatenessMinutes: Number(contractRow.allowed_lateness_minutes),
        maxQuietWindowMinutes:
          (contractRow.max_quiet_window_minutes as number | null) ?? null,
        initialGraceMinutes: Number(contractRow.initial_grace_minutes),
        emptyResultPolicy: contractRow.empty_result_policy as
          | "allowed"
          | "warning"
          | "failure",
        countLessSuccessAllowed: Boolean(
          contractRow.count_less_success_allowed,
        ),
        notificationBackoffMinutes: Number(
          contractRow.notification_backoff_minutes,
        ),
        evidenceLevel: contractRow.evidence_level as
          | "basic"
          | "medium"
          | "high",
        schemaVersion: Number(contractRow.schema_version ?? 1),
        isActive: true,
      },
      {
        activation: {
          hasActiveAlertRoute: testedRoute,
          acknowledgedNoAlertMode,
          edition: "self_hosted",
        },
        excludingContractId: contractId,
      },
    );
    if (!validation.ok) {
      return reply.type("text/html").send(
        renderProtectClientPage({
        ...pageShell,
          csrf: session.csrfToken,
          step: 6,
          clients: [],
          flash:
            validation.issues.map((i) => i.message).join(" ") ||
            "Activation gate failed.",
          draft: body,
        }),
      );
    }

    deps.sqlite
      .prepare(
        `UPDATE workflow_contracts
         SET is_active = 1, activated_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(nowIso, nowIso, tid, contractId);
    const workflowId = String(contractRow.workflow_id);
    deps.sqlite
      .prepare(
        `UPDATE workflows
         SET is_active = 1, monitoring_started_at = COALESCE(monitoring_started_at, ?), updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(nowIso, nowIso, tid, workflowId);

    // Seed next deadline so activation surfaces first expected window.
    const cadenceMinutes = Number(contractRow.cadence_value) || 15;
    const nextExpected = new Date(
      deps.clock.now().getTime() + cadenceMinutes * 60_000,
    ).toISOString();
    const existingState = core.getWorkflowState(tid, workflowId);
    core.upsertWorkflowState(tid, {
      tenantId: tid,
      workflowId,
      lastExecutionAt: existingState?.lastExecutionAt ?? null,
      lastNonemptySuccessAt: existingState?.lastNonemptySuccessAt ?? null,
      lastAcceptableSuccessAt: existingState?.lastAcceptableSuccessAt ?? null,
      lastFailureAt: existingState?.lastFailureAt ?? null,
      lastExternalExecutionRef: existingState?.lastExternalExecutionRef ?? null,
      lastStatus: existingState?.lastStatus ?? "unknown",
      nextExpectedAt: nextExpected,
      overdueSince: null,
      currentHealth: "unknown",
      evidenceLevel: "basic",
      evidenceSummaryCode: existingState?.evidenceSummaryCode ?? null,
      unverifiedDimensionsJson: existingState?.unverifiedDimensionsJson ?? null,
      consecutiveStaleChecks: existingState?.consecutiveStaleChecks ?? 0,
      updatedAt: nowIso,
    });

    if (body.clientId) {
      core.updateClientStatus(tid, body.clientId, "protected", nowIso, nowIso);
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "contract.activated",
      resourceType: "workflow_contract",
      resourceId: contractId,
      nowIso,
    });
    return reply.redirect(`/clients/${body.clientId || ""}`);
  });

  app.get("/clients", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const catalog = loadCatalogViews(tid);
    const clients = core.listClients(tid).map((c) => {
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
    return reply
      .type("text/html")
      .send(renderClientsPage({ ...pageShell, role: session.role, clients }));
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
    const rows = deps.sqlite
      .prepare(
        `SELECT id, severity, status, summary, opened_at
         FROM incidents
         WHERE tenant_id = ? AND status IN ('open', 'acknowledged')
         ORDER BY opened_at DESC
         LIMIT 100`,
      )
      .all(tid) as Array<{
      id: string;
      severity: string;
      status: string;
      summary: string;
      opened_at: string;
    }>;
    const body =
      rows.length === 0
        ? `<div class="empty-state"><h2>No open incidents</h2><p>Define contracts proactively. Do not wait for failures.</p><a class="btn" href="/catalog">Open Contract Catalog</a></div>`
        : `<div class="card table-wrap" style="padding:0"><table class="responsive-cards"><thead><tr><th>Severity</th><th>Status</th><th>Summary</th><th>Opened</th></tr></thead><tbody>${rows
            .map(
              (r) =>
                `<tr><td data-label="Severity" class="sev-${escapeHtml(r.severity)}">${escapeHtml(r.severity)}</td><td data-label="Status">${escapeHtml(r.status)}</td><td data-label="Summary">${escapeHtml(r.summary)}</td><td data-label="Opened" class="helper">${escapeHtml(r.opened_at)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`;
    return reply.type("text/html").send(
      renderSimpleNavPage({
        ...pageShell,
        title: "Incidents",
        current: "incidents",
        role: session.role,
        body: `<h1 class="page-title">Incidents</h1><p class="page-subtitle">Operational issues that need acknowledgement or resolution.</p>${body}`,
      }),
    );
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
    const tested = (request.query as { tested?: string }).tested;
    const flash =
      tested === "ok"
        ? `<p class="ok" role="status">Connector test succeeded.</p>`
        : tested === "fail"
          ? `<p class="err" role="alert">Connector test failed. Check health below.</p>`
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
                    ? `<form method="post" action="/connectors/n8n/${escapeHtml(r.id)}/test" style="display:inline">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                        <button type="submit" class="btn-secondary">Test connection</button>
                      </form>
                      ${
                        r.connector_status === "active"
                          ? `<form method="post" action="/connectors/n8n/${escapeHtml(r.id)}/disable" style="display:inline">
                        <input type="hidden" name="csrf" value="${escapeHtml(session.csrfToken)}" />
                        <button type="submit" class="btn-ghost">Disable</button>
                      </form>`
                          : ""
                      }`
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
        `SELECT received_at AS at, status AS label FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ?
         ORDER BY received_at DESC LIMIT 8`,
      )
      .all(tid, workflowId) as Array<{ at: string; label: string }>;

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
          label: e.label,
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
