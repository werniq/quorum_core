import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import type { Clock } from "../../../domain/clock.js";
import { assertExplicitContractConfirmation } from "../../../domain/contracts/explicit-activation.js";
import { validateWorkflowContract } from "../../../domain/contracts/validate-workflow-contract.js";
import { createId } from "../../../domain/ids.js";
import { getProcessTemplate } from "../../../domain/catalog/process-templates.js";
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
import { renderProtectClientPage } from "../../../presentation/html/catalog-ui.js";
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

/**
 * Legacy Protect POST handlers kept for verification scripts and bookmarks.
 * GET /protect redirects to /onboarding (canonical UI).
 */
export function registerProtectCompatRoutes(
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

  function listProtectWorkflows(tid: string) {
    return core.listWorkflows(tid).map((w) => ({
      id: w.id,
      name: w.name,
      externalWorkflowId: w.externalWorkflowId,
      monitoringMethod: w.monitoringMethod,
    }));
  }

  function listProtectClients(tid: string) {
    return core.listClients(tid).map((c) => ({ id: c.id, name: c.name }));
  }

  app.post("/protect/back", async (request, reply) => {
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
    const parsed = Number.parseInt(body.to ?? "1", 10);
    const step = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 5) : 1;
    return reply.type("text/html").send(
      renderProtectClientPage({
        ...pageShell,
        csrf: session.csrfToken,
        step,
        clients: listProtectClients(tid),
        workflows: listProtectWorkflows(tid),
        draft: body,
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
        clients: listProtectClients(tid),
        workflows: listProtectWorkflows(tid),
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
    const tid = deps.tenantId();
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
        clients: listProtectClients(tid),
        workflows: listProtectWorkflows(tid),
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
    const clients = listProtectClients(tid);
    const workflows = listProtectWorkflows(tid);
    const existingWorkflowId = (body.existingWorkflowId ?? "").trim();
    const workflowName = (body.workflowName ?? "").trim();
    const externalWorkflowId = (body.externalWorkflowId ?? "").trim();
    const monitoringMethod = body.monitoringMethod === "push" ? "push" : "poll";
    const draft = {
      clientId: body.clientId ?? "",
      templateId: body.templateId ?? "",
      businessPurpose: body.businessPurpose ?? "",
      cadenceValue: body.cadenceValue ?? "15",
      workflowName,
      externalWorkflowId,
      monitoringMethod,
      workflowId: existingWorkflowId,
    };

    if (existingWorkflowId) {
      const existing = core.getWorkflow(tid, existingWorkflowId);
      if (!existing) {
        return reply
          .code(400)
          .type("text/html")
          .send(
            renderProtectClientPage({
              ...pageShell,
              csrf: session.csrfToken,
              step: 3,
              clients,
              workflows,
              flash:
                "That registered workflow was not found. Select another or register a new one.",
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
          workflows,
          flash: `Using existing workflow “${existing.name}”. Quorum workflow id: ${existing.id}. Define the monitoring contract next.`,
          flashTone: "success",
          draft: {
            ...draft,
            workflowId: existing.id,
            workflowName: existing.name,
            externalWorkflowId: existing.externalWorkflowId,
            monitoringMethod: existing.monitoringMethod,
          },
        }),
      );
    }

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
            workflows,
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
            workflows,
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
        workflows,
        flash: `Workflow registered. Quorum workflow ID: ${workflow.id} (for push signing / QUORUM_WORKFLOW_ID — not the n8n workflow ID). Define the monitoring contract next.`,
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
    const acknowledgedNoAlertMode = body.acknowledgedNoAlertMode === "1";
    const url = (body.url ?? "").trim();
    const draftBase = {
      clientId: body.clientId ?? "",
      workflowId: body.workflowId ?? "",
      contractId: body.contractId ?? "",
      acknowledgedNoAlertMode: acknowledgedNoAlertMode ? "1" : "",
    };

    if (acknowledgedNoAlertMode) {
      return reply.type("text/html").send(
        renderProtectClientPage({
          ...pageShell,
          csrf: session.csrfToken,
          step: 6,
          clients: [],
          flash:
            "Alert delivery skipped. Catalog will still show monitoring status (with No alert channel).",
          flashTone: "success",
          draft: draftBase,
        }),
      );
    }

    if (!url) {
      return reply.type("text/html").send(
        renderProtectClientPage({
          ...pageShell,
          csrf: session.csrfToken,
          step: 5,
          clients: [],
          flash:
            "Enter a webhook URL, or check “Skip alert delivery for now” to continue without outbound alerts.",
          draft: {
            ...draftBase,
            channelName: body.channelName ?? "Ops webhook",
          },
        }),
      );
    }

    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const channelId = createId();
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
          ...draftBase,
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
}
