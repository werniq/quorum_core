import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import type { Clock } from "../../../domain/clock.js";
import type { QuorumEnv } from "../../config/env.js";
import { createId } from "../../../domain/ids.js";
import { SqliteCoreRepositories } from "../../db/repositories/sqlite-core-repositories.js";
import {
  SqliteOnboardingRepositories,
  type OnboardingStep,
} from "../../db/repositories/sqlite-onboarding-repositories.js";
import { SqliteN8nConnectorRepositories } from "../../db/repositories/sqlite-n8n-connector-repositories.js";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { SqliteOpsAuditRepositories } from "../../db/repositories/sqlite-ops-audit-repositories.js";
import { SqliteOutboundDestinationRepositories } from "../../db/repositories/sqlite-outbound-destinations.js";
import { SqliteVolumeRepositories } from "../../db/repositories/sqlite-volume-repositories.js";
import { encryptCredentialSecret } from "../../security/credential-secrets.js";
import { decryptCredentialSecret } from "../../security/credential-secrets.js";
import { assertSelfHostedConnectorUrl } from "../../security/secure-outbound-http.js";
import {
  listN8nWorkflows,
  validateN8nConnectorConnectivity,
} from "../../n8n/n8n-api-client.js";
import { renderSimplifiedOnboardingPage } from "../../../presentation/html/simplified-onboarding-ui.js";
import type { OnboardingDraft } from "../../../domain/onboarding/draft.js";
import type { OnboardingWorkflowConfig } from "../../../domain/onboarding/draft.js";
import {
  parseOnboardingDraft,
  selectedWorkflowConfigs,
} from "../../../domain/onboarding/draft.js";
import type {
  CadenceType,
  MonitoringMethod,
} from "../../../domain/contracts/types.js";
import { validateWorkflowContract } from "../../../domain/contracts/validate-workflow-contract.js";
import type { DiscoveredWorkflow } from "../../../domain/n8n/discovered-workflow.js";
import {
  buildHeartbeatSigningPayload,
  sha256Hex,
  signHeartbeatHmacSha256,
} from "../../security/heartbeat-hmac.js";
import { quorumReporterTemplateJson } from "../../n8n/quorum-reporter-template.js";
import { computeNextExpectedIso } from "../../ingestion/apply-heartbeat-state.js";

const HTTP_TIMEOUTS = {
  connectTimeoutMs: 5_000,
  readTimeoutMs: 15_000,
  maxResponseBytes: 2_000_000,
  maxRedirects: 3,
  networkPolicy: "self_hosted_local" as const,
};

type Session = {
  adminUserId: string;
  csrfToken: string;
  role: "admin" | "operator" | "viewer";
};

function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "client"
  );
}

function formBody(request: FastifyRequest): Record<string, string> {
  const body = request.body;
  if (!body || typeof body !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      out[key] = value[0];
    }
  }
  return out;
}

function formBodyMulti(request: FastifyRequest, key: string): string[] {
  const body = request.body;
  if (!body || typeof body !== "object") {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

const BACK_TARGETS: OnboardingStep[] = [
  "client",
  "connect_n8n",
  "select_workflows",
  "configure_monitoring",
  "alerts_activate",
  "complete",
];

export function registerSimplifiedOnboardingRoutes(
  app: FastifyInstance,
  deps: {
    env: QuorumEnv;
    sqlite: Database.Database;
    clock: Clock;
    processOutbox?: { processBatch: (limit: number) => Promise<unknown> };
    requireSession: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Session | null;
    assertCsrf: (
      request: FastifyRequest,
      session: Session,
      reply: FastifyReply,
    ) => boolean;
    requireAdmin: (session: Session, reply: FastifyReply) => boolean;
    tenantId: () => string;
    demoMode?: boolean;
  },
): void {
  const core = new SqliteCoreRepositories(deps.sqlite);
  const onboarding = new SqliteOnboardingRepositories(deps.sqlite);
  const n8nConnectors = new SqliteN8nConnectorRepositories(deps.sqlite);
  const alerting = new SqliteAlertingRepositories(deps.sqlite);
  const opsAudit = new SqliteOpsAuditRepositories(deps.sqlite);
  const outbound = new SqliteOutboundDestinationRepositories(deps.sqlite);
  const volume = new SqliteVolumeRepositories(deps.sqlite);
  const pageShell = { demoMode: deps.demoMode === true };

  // Repairs contracts activated by the older simplified-onboarding path,
  // which retained stale defaults when a workflow already had an inactive
  // contract. The activation timestamp guard avoids overriding later edits.
  const completedDrafts = deps.sqlite
    .prepare(
      `SELECT tenant_id, draft_json FROM onboarding_state
       WHERE completed_at IS NOT NULL OR step = 'complete'`,
    )
    .all() as Array<{ tenant_id: string; draft_json: string }>;
  for (const saved of completedDrafts) {
    const draft = parseOnboardingDraft(saved.draft_json);
    if (!draft.activatedAt) continue;
    for (const config of selectedWorkflowConfigs(draft)) {
      if (!config.workflowId || !config.contractId) continue;
      const contract = deps.sqlite
        .prepare(
          `SELECT * FROM workflow_contracts
           WHERE tenant_id = ? AND id = ? AND workflow_id = ?
             AND activated_at = ? LIMIT 1`,
        )
        .get(
          saved.tenant_id,
          config.contractId,
          config.workflowId,
          draft.activatedAt,
        ) as Record<string, unknown> | undefined;
      if (!contract) continue;
      const quietMinutes =
        config.cadenceType === "event_driven"
          ? Math.round((config.quietHours ?? 24) * 60)
          : null;
      const expectedEmptyPolicy = config.monitorEmptyResult
        ? "failure"
        : "allowed";
      const needsRepair =
        String(contract.cadence_type) !== config.cadenceType ||
        String(contract.cadence_value) !== config.cadenceValue ||
        (contract.max_quiet_window_minutes as number | null) !== quietMinutes ||
        String(contract.empty_result_policy) !== expectedEmptyPolicy ||
        Boolean(contract.count_less_success_allowed) ===
          config.monitorEmptyResult;
      if (!needsRepair) continue;
      deps.sqlite
        .prepare(
          `UPDATE workflow_contracts
           SET cadence_type = ?, cadence_value = ?, interval_mode = ?,
               schedule_anchor_at = ?, timezone = ?,
               max_quiet_window_minutes = ?, empty_result_policy = ?,
               count_less_success_allowed = ?, updated_at = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          config.cadenceType,
          config.cadenceValue,
          config.cadenceType === "interval" ? "fixed_rate" : null,
          config.cadenceType === "interval" ? draft.activatedAt : null,
          config.timezone ?? "UTC",
          quietMinutes,
          expectedEmptyPolicy,
          config.monitorEmptyResult ? 0 : 1,
          deps.clock.now().toISOString(),
          saved.tenant_id,
          config.contractId,
        );
      const repairedContract = deps.sqlite
        .prepare(`SELECT * FROM workflow_contracts WHERE id = ?`)
        .get(config.contractId) as Record<string, unknown>;
      const state = core.getWorkflowState(saved.tenant_id, config.workflowId);
      const deadlineOrigin = state?.lastExecutionAt ?? draft.activatedAt;
      const nextExpected = computeNextExpectedIso({
        contract: repairedContract,
        lastReportAt: deadlineOrigin,
        clock: deps.clock,
      });
      deps.sqlite
        .prepare(
          `UPDATE workflow_states SET next_expected_at = ?, updated_at = ?
           WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .run(
          nextExpected,
          deps.clock.now().toISOString(),
          saved.tenant_id,
          config.workflowId,
        );
    }
  }

  async function discover(
    tid: string,
    connectorId: string,
  ): Promise<
    | { ok: true; workflows: DiscoveredWorkflow[] }
    | { ok: false; message: string }
  > {
    const connector = n8nConnectors.getConnector(tid, connectorId);
    if (!connector) {
      return { ok: false, message: "n8n connection not found." };
    }
    let apiKey: string;
    try {
      apiKey = decryptCredentialSecret(
        connector.encryptedApiKey,
        deps.env.QUORUM_CREDENTIAL_KEK,
      );
    } catch {
      return {
        ok: false,
        message: "Could not decrypt the stored n8n API key.",
      };
    }
    const result = await listN8nWorkflows({
      endpoint: { baseUrl: connector.baseUrl, apiKey },
      options: HTTP_TIMEOUTS,
    });
    if (!result.ok) {
      return { ok: false, message: result.summary };
    }
    return { ok: true, workflows: result.value };
  }

  function protectedExternalIds(tid: string): Set<string> {
    const ids = new Set<string>();
    for (const workflow of core.listWorkflows(tid)) {
      const activeContract = deps.sqlite
        .prepare(
          `SELECT 1 AS ok FROM workflow_contracts
           WHERE tenant_id = ? AND workflow_id = ? AND is_active = 1 LIMIT 1`,
        )
        .get(tid, workflow.id) as { ok: number } | undefined;
      if (activeContract) {
        ids.add(workflow.externalWorkflowId);
      }
    }
    return ids;
  }

  async function render(
    reply: FastifyReply,
    session: Session,
    tid: string,
    extras: {
      flash?: string | null;
      flashTone?: "error" | "success";
      discovered?: DiscoveredWorkflow[];
      discoveryError?: string | null;
      outcomeSetups?: Array<{
        workflowName: string;
        workflowId: string;
        keyId: string;
        secret: string;
        ingestPath: string;
      }>;
    } = {},
  ) {
    const state = onboarding.ensure(tid, deps.clock.now().toISOString());
    let discovered = extras.discovered;
    let discoveryError = extras.discoveryError ?? null;
    if (
      (state.step === "select_workflows" ||
        state.step === "configure_monitoring") &&
      state.draft.connectorId &&
      discovered === undefined
    ) {
      const result = await discover(tid, state.draft.connectorId);
      if (result.ok) {
        discovered = result.workflows;
      } else {
        discoveryError = result.message;
        discovered = [];
      }
    }

    const completionRows =
      state.step === "complete"
        ? selectedWorkflowConfigs(state.draft).map((cfg) => {
            const workflowId = cfg.workflowId;
            const stateRow = workflowId
              ? core.getWorkflowState(tid, workflowId)
              : null;
            const hasEvidence = Boolean(
              stateRow?.lastExecutionAt ||
                stateRow?.lastAcceptableSuccessAt ||
                stateRow?.lastFailureAt,
            );
            const monitoring = Boolean(cfg.contractId);
            let statusLabel = "Waiting for first execution";
            if (monitoring && hasEvidence) {
              statusLabel =
                stateRow?.currentHealth === "overdue" ||
                stateRow?.currentHealth === "warning"
                  ? "Attention required"
                  : "Monitoring active";
            } else if (monitoring) {
              statusLabel = "Waiting for first execution";
            }
            return {
              name: cfg.name,
              monitoringMode:
                cfg.monitoringMethod === "push"
                  ? "Outcome monitoring"
                  : "Basic monitoring",
              alertRules: [
                cfg.monitorMissingRuns ? "It does not run on time" : null,
                cfg.monitorFailures ? "An execution fails" : null,
                cfg.monitorEmptyResult ? "Useful output is zero" : null,
                cfg.monitorVolumeRange
                  ? "Useful item count is outside its range"
                  : null,
              ].filter((rule): rule is string => rule !== null),
              timingLabel:
                cfg.cadenceType === "event_driven"
                  ? `Alert after ${String(cfg.quietHours ?? 24)} hours without an event`
                  : `Expected cadence: ${cfg.cadenceValue}`,
              outcomeThreshold: cfg.monitorVolumeRange
                ? `${cfg.volumeMin ?? "no minimum"} to ${cfg.volumeMax ?? "no maximum"} useful items`
                : cfg.monitorEmptyResult
                  ? "At least 1 useful item"
                  : null,
              heartbeatAccepted: Boolean(
                cfg.workflowId &&
                  state.draft.heartbeatAcceptedWorkflowIds?.includes(
                    cfg.workflowId,
                  ),
              ),
              statusLabel,
              connected: Boolean(state.draft.connectorId),
              discovered: true,
              monitoring,
              alertTested: state.draft.alertTestOk ?? null,
              waitingFirst: monitoring && !hasEvidence,
            };
          })
        : undefined;

    const pageInput: Parameters<typeof renderSimplifiedOnboardingPage>[0] = {
      ...pageShell,
      csrf: session.csrfToken,
      step: state.step,
      draft: state.draft,
      flash: extras.flash ?? null,
      flashTone: extras.flashTone ?? "error",
      clients: core.listClients(tid).map((c) => ({ id: c.id, name: c.name })),
      connectors: n8nConnectors.listConnectors(tid).map((c) => ({
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl,
      })),
      alertChannels: (
        deps.sqlite
          .prepare(
            `SELECT c.id, c.name, COALESCE(s.current_health, 'unknown') AS health
             FROM alert_channels c
             LEFT JOIN alert_channel_states s
               ON s.tenant_id = c.tenant_id AND s.alert_channel_id = c.id
             WHERE c.tenant_id = ? AND c.is_active = 1
             ORDER BY c.created_at ASC`,
          )
          .all(tid) as Array<{ id: string; name: string; health: string }>
      ).map((r) => ({ id: r.id, name: r.name, health: r.health })),
      protectedExternalIds: protectedExternalIds(tid),
    };
    if (discovered) {
      pageInput.discovered = discovered;
    }
    if (discoveryError) {
      pageInput.discoveryError = discoveryError;
    }
    if (completionRows) {
      pageInput.completionRows = completionRows;
    }
    if (extras.outcomeSetups) {
      pageInput.outcomeSetups = extras.outcomeSetups;
    }
    return reply
      .type("text/html")
      .send(renderSimplifiedOnboardingPage(pageInput));
  }

  app.get("/onboarding", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = deps.tenantId();
    const query = request.query as { search?: string; error?: string };
    const state = onboarding.ensure(tid, deps.clock.now().toISOString());
    if (query.search !== undefined) {
      const draft: OnboardingDraft = {
        ...state.draft,
        search: query.search,
      };
      onboarding.saveDraft(tid, draft, deps.clock.now().toISOString());
    }
    return render(reply, session, tid, {
      flash: query.error ? query.error : null,
      flashTone: query.error ? "error" : "error",
    });
  });

  app.get("/onboarding/quorum-reporter.json", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (!session) return;
    const workflowId = String(
      (request.query as { workflowId?: string }).workflowId ?? "",
    ).trim();
    const credential = deps.sqlite
      .prepare(
        `SELECT c.key_id, wc.empty_result_policy
         FROM workflow_credentials c
         JOIN workflow_contracts wc
           ON wc.tenant_id = c.tenant_id AND wc.workflow_id = c.workflow_id
         WHERE c.tenant_id = ? AND c.workflow_id = ? AND c.status = 'active'
         ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get(deps.tenantId(), workflowId) as
      | { key_id: string; empty_result_policy: string }
      | undefined;
    if (!credential) {
      return reply.code(404).type("text/plain").send("Reporter not available");
    }
    return reply
      .header(
        "content-disposition",
        'attachment; filename="quorum-reporter.json"',
      )
      .type("application/json")
      .send(
        quorumReporterTemplateJson({
          quorumBaseUrl: deps.env.PUBLIC_BASE_URL,
          workflowId,
          keyId: credential.key_id,
          outputMonitoringEnabled: credential.empty_result_policy !== "allowed",
        }),
      );
  });

  app.post("/onboarding/heartbeat/test", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const workflowId = (formBody(request).workflowId ?? "").trim();
    const tid = deps.tenantId();
    const workflow = deps.sqlite
      .prepare(
        `SELECT id FROM workflows WHERE tenant_id = ? AND id = ? LIMIT 1`,
      )
      .get(tid, workflowId) as { id: string } | undefined;
    if (!workflow) {
      return render(reply, session, tid, {
        flash:
          "Workflow not found. Return to workflow selection and try again.",
      });
    }
    const credential = deps.sqlite
      .prepare(
        `SELECT key_id, encrypted_secret_or_verification_material
         FROM workflow_credentials
         WHERE tenant_id = ? AND workflow_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tid, workflowId) as
      | {
          key_id: string;
          encrypted_secret_or_verification_material: string;
        }
      | undefined;
    if (!credential) {
      return render(reply, session, tid, {
        flash:
          "Wrong Key ID or no active credential. Issue or rotate the Outcome monitoring credential and try again.",
      });
    }
    let secret: string;
    try {
      secret = decryptCredentialSecret(
        credential.encrypted_secret_or_verification_material,
        deps.env.QUORUM_CREDENTIAL_KEK,
      );
    } catch {
      return render(reply, session, tid, {
        flash:
          "The signing credential could not be read. Rotate it and try again.",
      });
    }
    const path = `/api/v1/workflows/${workflowId}/heartbeats`;
    const timestampSeconds = String(
      Math.floor(deps.clock.now().getTime() / 1000),
    );
    const idempotencyKey = `onboarding-test-${createId()}`;
    const rawBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: deps.clock.now().toISOString(),
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: idempotencyKey,
      }),
      "utf8",
    );
    const signature = signHeartbeatHmacSha256(
      secret,
      buildHeartbeatSigningPayload({
        method: "POST",
        path,
        timestampSeconds,
        idempotencyKey,
        bodySha256Hex: sha256Hex(rawBody),
      }),
    );
    let response;
    try {
      response = await app.inject({
        method: "POST",
        url: path,
        headers: {
          "content-type": "application/json",
          "x-quorum-key-id": credential.key_id,
          "x-quorum-timestamp": timestampSeconds,
          "x-quorum-idempotency-key": idempotencyKey,
          "x-quorum-signature": signature,
        },
        payload: rawBody,
      });
    } catch {
      return render(reply, session, tid, {
        flash:
          "The ingest endpoint could not be reached. Check the Quorum service and try again.",
      });
    }
    if (response.statusCode !== 202) {
      const messages: Record<number, string> = {
        401: "Invalid signature, wrong Key ID, or expired timestamp. Rotate the credential and retry.",
        404: "Workflow not found. Check that you used the Quorum workflow ID, not the n8n workflow ID.",
        409: "The workflow contract is inactive. Activate monitoring before sending a heartbeat.",
        503: "The ingest endpoint is not ready. Check migration status and retry.",
      };
      return render(reply, session, tid, {
        flash:
          messages[response.statusCode] ??
          `Heartbeat failed with HTTP ${response.statusCode}. Check the ingest response and retry.`,
      });
    }
    const state = onboarding.ensure(tid, deps.clock.now().toISOString());
    onboarding.saveDraft(
      tid,
      {
        ...state.draft,
        heartbeatAcceptedWorkflowIds: [
          ...new Set([
            ...(state.draft.heartbeatAcceptedWorkflowIds ?? []),
            workflowId,
          ]),
        ],
      },
      deps.clock.now().toISOString(),
    );
    return render(reply, session, tid, {
      flash: "Heartbeat accepted. Outcome monitoring is active.",
      flashTone: "success",
    });
  });

  app.post("/onboarding/back", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const to = body.to as OnboardingStep;
    if (!BACK_TARGETS.includes(to)) {
      return reply.redirect("/onboarding");
    }
    const tid = deps.tenantId();
    const state = onboarding.ensure(tid, deps.clock.now().toISOString());
    onboarding.setStep(tid, to, deps.clock.now().toISOString(), {
      draft: state.draft,
    });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/client", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    let clientId = (body.clientId ?? "").trim();
    let clientName = (body.newClientName ?? "").trim();
    if (!clientId) {
      if (!clientName) {
        return render(reply, session, tid, {
          flash: "Enter a client name or select an existing client.",
        });
      }
      const client = core.createClient(tid, {
        id: createId(),
        name: clientName,
        slug: slugFromName(clientName),
        status: "onboarding",
        protectionStartedAt: null,
      });
      clientId = client.id;
    } else {
      const existing = core.getClient(tid, clientId);
      if (!existing) {
        return render(reply, session, tid, {
          flash: "That client is not available.",
        });
      }
      clientName = existing.name;
    }
    const draft: OnboardingDraft = {
      ...state.draft,
      clientId,
      clientName,
    };
    onboarding.setStep(tid, "connect_n8n", nowIso, { draft });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/connect/select", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    const connectorId = (body.connectorId ?? "").trim();
    const connector = n8nConnectors.getConnector(tid, connectorId);
    if (!connector) {
      return render(reply, session, tid, {
        flash: "Select an existing n8n connection.",
      });
    }
    const draft: OnboardingDraft = {
      ...state.draft,
      connectorId: connector.id,
      connectorLabel: connector.name,
      connectionTestOk: connector.health === "healthy",
      selectedExternalWorkflowIds: [],
      workflowConfigs: {},
    };
    onboarding.setStep(tid, "select_workflows", nowIso, { draft });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/connect", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    const apiKey = body.apiKey ?? "";
    const name = (body.name ?? "n8n").trim() || "n8n";
    let baseUrl: string;
    try {
      baseUrl = assertSelfHostedConnectorUrl(body.baseUrl ?? "").toString();
      baseUrl = baseUrl.replace(/\/+$/, "");
    } catch {
      return render(reply, session, tid, {
        flash:
          "That n8n URL is not allowed. Use a reachable self-hosted address.",
      });
    }
    if (!apiKey.trim()) {
      return render(reply, session, tid, {
        flash: "Enter an n8n API key.",
      });
    }

    const existing = n8nConnectors.findConnectorByNormalizedBaseUrl(
      tid,
      baseUrl,
    );
    let connectorId = existing?.id;
    if (!connectorId) {
      const connector = n8nConnectors.createConnector(tid, {
        name,
        baseUrl,
        encryptedApiKey: encryptCredentialSecret(
          apiKey,
          deps.env.QUORUM_CREDENTIAL_KEK,
        ),
        nowIso,
        enforcePublicUrl: false,
        status: "active",
        pollIntervalMs: deps.env.N8N_POLL_DEFAULT_INTERVAL_MS ?? 60_000,
      });
      connectorId = connector.id;
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "connector.created",
        resourceType: "n8n_connector",
        resourceId: connector.id,
        details: { name: connector.name, baseUrl: connector.baseUrl },
        nowIso,
      });
    } else {
      n8nConnectors.updateConnectorCredential(tid, connectorId, {
        encryptedApiKey: encryptCredentialSecret(
          apiKey,
          deps.env.QUORUM_CREDENTIAL_KEK,
        ),
        nowIso,
      });
    }

    const test = await validateN8nConnectorConnectivity(
      { baseUrl, apiKey },
      HTTP_TIMEOUTS,
    );
    n8nConnectors.updateConnectorHealth(tid, connectorId, {
      health: test.ok ? "healthy" : test.health,
      checkedAtIso: nowIso,
      success: test.ok,
      errorCode: test.ok ? null : test.code,
      errorSummary: test.ok ? null : test.summary,
    });
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "connector.tested",
      resourceType: "n8n_connector",
      resourceId: connectorId,
      details: { ok: test.ok },
      nowIso,
    });

    if (!test.ok) {
      const draft: OnboardingDraft = {
        ...state.draft,
        connectorId,
        connectionTestOk: false,
      };
      onboarding.setStep(tid, "connect_n8n", nowIso, { draft });
      return render(reply, session, tid, { flash: test.summary });
    }

    // Count via full discovery when possible
    const listed = await listN8nWorkflows({
      endpoint: { baseUrl, apiKey },
      options: HTTP_TIMEOUTS,
    });
    const count = listed.ok
      ? listed.value.length
      : (test.value.workflowCountHint ?? null);

    const draft: OnboardingDraft = {
      ...state.draft,
      connectorId,
      connectorLabel: name,
      connectionTestOk: true,
      workflowCountHint: count,
      selectedExternalWorkflowIds: [],
      workflowConfigs: {},
    };
    onboarding.setStep(tid, "select_workflows", nowIso, { draft });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/workflows/refresh", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/workflows/manual", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    const name = (body.name ?? "").trim();
    const externalWorkflowId = (body.externalWorkflowId ?? "").trim();
    if (!name || !externalWorkflowId) {
      return render(reply, session, tid, {
        flash: "Enter both a workflow name and n8n workflow ID.",
      });
    }
    const selected = new Set(state.draft.selectedExternalWorkflowIds ?? []);
    selected.add(externalWorkflowId);
    const configs = { ...(state.draft.workflowConfigs ?? {}) };
    configs[externalWorkflowId] = {
      externalWorkflowId,
      name,
      activeInN8n: true,
      triggerSummary: "Entered manually — confirm expected cadence",
      cadenceType: "interval",
      cadenceValue: "15m",
      timezone: "UTC",
      quietHours: 24,
      monitorMissingRuns: true,
      monitorFailures: true,
      monitorEmptyResult: false,
      monitorVolumeRange: false,
      volumeMin: null,
      volumeMax: null,
      monitoringMethod: "poll",
    };
    onboarding.setStep(tid, "select_workflows", nowIso, {
      draft: {
        ...state.draft,
        selectedExternalWorkflowIds: [...selected],
        workflowConfigs: configs,
      },
    });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/workflows/select", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    if (!state.draft.connectorId) {
      return render(reply, session, tid, {
        flash: "Connect n8n before selecting workflows.",
      });
    }
    const discovery = await discover(tid, state.draft.connectorId);
    const byId = new Map(
      (discovery.ok ? discovery.workflows : []).map((w) => [
        w.externalWorkflowId,
        w,
      ]),
    );
    const protectedIds = protectedExternalIds(tid);
    const selected = formBodyMulti(request, "externalWorkflowIds").filter(
      (id) => !protectedIds.has(id),
    );
    const manualIds = (state.draft.selectedExternalWorkflowIds ?? []).filter(
      (id) => !byId.has(id) && !protectedIds.has(id),
    );
    const allSelected = [...new Set([...selected, ...manualIds])];
    if (allSelected.length === 0) {
      return render(reply, session, tid, {
        flash: "Select at least one workflow to continue.",
      });
    }
    const previousConfigs = state.draft.workflowConfigs ?? {};
    const configs: Record<string, OnboardingWorkflowConfig> = {};
    for (const id of allSelected) {
      const found = byId.get(id);
      const existing = previousConfigs[id];
      if (existing && !found) {
        configs[id] = existing;
        continue;
      }
      if (found) {
        const cadenceType: CadenceType =
          found.inferredCadence?.type === "cron"
            ? "cron"
            : found.triggerKind === "schedule" && found.inferredCadence
              ? "interval"
              : found.triggerKind === "webhook" ||
                  found.triggerKind === "event" ||
                  found.triggerKind === "manual"
                ? "event_driven"
                : "interval";
        const cadenceValue =
          found.inferredCadence?.value ??
          (cadenceType === "event_driven" ? "24h" : "15m");
        configs[id] = {
          externalWorkflowId: id,
          name: found.name,
          activeInN8n: found.active,
          triggerSummary: found.triggerSummary,
          cadenceType,
          cadenceValue,
          timezone: found.inferredCadence?.timezone ?? "UTC",
          quietHours: cadenceType === "event_driven" ? 24 : null,
          monitorMissingRuns: cadenceType !== "event_driven",
          monitorFailures: true,
          monitorEmptyResult: false,
          monitorVolumeRange: false,
          volumeMin: null,
          volumeMax: null,
          monitoringMethod: "poll",
          alreadyMonitored: false,
          ...(existing?.workflowId ? { workflowId: existing.workflowId } : {}),
          ...(existing?.contractId ? { contractId: existing.contractId } : {}),
        };
      }
    }
    onboarding.setStep(tid, "configure_monitoring", nowIso, {
      draft: {
        ...state.draft,
        selectedExternalWorkflowIds: allSelected,
        workflowConfigs: configs,
      },
    });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/configure", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    const selectedIds = new Set(state.draft.selectedExternalWorkflowIds ?? []);
    const configs = Object.fromEntries(
      selectedWorkflowConfigs(state.draft).map((config) => [
        config.externalWorkflowId,
        config,
      ]),
    );
    for (let i = 0; i < 50; i += 1) {
      const externalId = body[`wfid__${i}`];
      if (!externalId || !selectedIds.has(externalId) || !configs[externalId]) {
        if (!externalId) break;
        continue;
      }
      const current = configs[externalId]!;
      const cadenceType = (body[`cadenceType__${i}`] ??
        current.cadenceType) as CadenceType;
      const cadenceValue = (
        body[`cadenceValue__${i}`] ?? current.cadenceValue
      ).trim();
      if (cadenceType !== "event_driven" && !cadenceValue) {
        return render(reply, session, tid, {
          flash: `Confirm the expected cadence for “${current.name}”.`,
        });
      }
      const quietHours = Number(
        body[`quietHours__${i}`] ?? current.quietHours ?? 24,
      );
      if (
        cadenceType === "event_driven" &&
        (!Number.isFinite(quietHours) || quietHours <= 0)
      ) {
        return render(reply, session, tid, {
          flash: `Enter how many quiet hours are allowed for “${current.name}”.`,
        });
      }
      const monitoringMethod = (
        body[`method__${i}`] === "push" ? "push" : "poll"
      ) as MonitoringMethod;
      const monitorEmptyResult = body[`empty__${i}`] === "1";
      const monitorVolumeRange = body[`volume__${i}`] === "1";
      if (
        monitoringMethod !== "push" &&
        (monitorEmptyResult || monitorVolumeRange)
      ) {
        return render(reply, session, tid, {
          flash: `Choose Outcome monitoring for “${current.name}” to use useful-output rules.`,
        });
      }
      const volumeMinRaw = (body[`vmin__${i}`] ?? "").trim();
      const volumeMaxRaw = (body[`vmax__${i}`] ?? "").trim();
      const volumeMin = volumeMinRaw === "" ? null : Number(volumeMinRaw);
      const volumeMax = volumeMaxRaw === "" ? null : Number(volumeMaxRaw);
      if (monitorVolumeRange && volumeMin === null && volumeMax === null) {
        return render(reply, session, tid, {
          flash: `Enter a minimum and/or maximum useful item count for “${current.name}”.`,
        });
      }
      if (
        (volumeMin !== null &&
          (!Number.isInteger(volumeMin) || volumeMin < 0)) ||
        (volumeMax !== null &&
          (!Number.isInteger(volumeMax) || volumeMax < 0)) ||
        (volumeMin !== null && volumeMax !== null && volumeMin > volumeMax)
      ) {
        return render(reply, session, tid, {
          flash: `Enter a valid useful item range for “${current.name}”; minimum cannot exceed maximum.`,
        });
      }
      configs[externalId] = {
        ...current,
        cadenceType,
        cadenceValue: cadenceType === "event_driven" ? "event" : cadenceValue,
        quietHours: cadenceType === "event_driven" ? quietHours : null,
        timezone: (body[`timezone__${i}`] ?? current.timezone ?? "UTC").trim(),
        monitorMissingRuns: body[`missing__${i}`] === "1",
        monitorFailures: body[`failure__${i}`] === "1",
        monitorEmptyResult,
        monitorVolumeRange,
        volumeMin,
        volumeMax,
        monitoringMethod,
      };
    }
    onboarding.setStep(tid, "alerts_activate", nowIso, {
      draft: { ...state.draft, workflowConfigs: configs },
    });
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/alerts", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = deps.tenantId();
    const nowIso = deps.clock.now().toISOString();
    const state = onboarding.ensure(tid, nowIso);
    const action = body.action === "activate" ? "activate" : "test";
    const acknowledgedNoAlertMode = body.acknowledgedNoAlertMode === "1";
    let channelId = (body.channelId ?? "").trim();
    let alertTestOk: boolean | null = state.draft.alertTestOk ?? null;

    if (!acknowledgedNoAlertMode) {
      if (!channelId) {
        const channelName = (body.channelName ?? "").trim() || "Ops webhook";
        const webhookUrl = (body.webhookUrl ?? "").trim();
        if (!webhookUrl) {
          return render(reply, session, tid, {
            flash:
              "Enter a webhook URL, select an existing channel, or continue without notifications.",
          });
        }
        const encrypted = encryptCredentialSecret(
          JSON.stringify({ url: webhookUrl }),
          deps.env.QUORUM_CREDENTIAL_KEK,
        );
        const channel = alerting.createAlertChannel(tid, {
          id: createId(),
          name: channelName,
          type: "webhook",
          encryptedConfig: encrypted,
          isActive: true,
        });
        channelId = channel.id;
        try {
          outbound.upsertDestination({
            tenantId: tid,
            kind: "webhook",
            destination: webhookUrl,
            label: channelName,
            nowIso,
          });
        } catch {
          // allowlist may reject; still keep channel
        }
      }

      const outboxId = createId();
      alerting.enqueueOutbox(tid, {
        id: outboxId,
        incidentId: null,
        eventType: "channel_test",
        payloadJson: JSON.stringify({ channelId }),
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
      const channelState = alerting.getAlertChannelState(tid, channelId);
      alertTestOk =
        channelState?.currentHealth === "healthy" ||
        channelState?.lastSuccessAt != null ||
        channelState?.lastTestedAt != null;
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "alert_channel.tested",
        resourceType: "alert_channel",
        resourceId: channelId,
        nowIso,
      });
    }

    const draft: OnboardingDraft = {
      ...state.draft,
      acknowledgedNoAlertMode,
      alertTestOk: acknowledgedNoAlertMode ? null : alertTestOk,
    };
    if (channelId) {
      draft.channelId = channelId;
    }
    const channelName = (
      body.channelName ||
      state.draft.channelName ||
      ""
    ).trim();
    if (channelName) {
      draft.channelName = channelName;
    }
    onboarding.setStep(tid, "alerts_activate", nowIso, { draft });

    if (action === "test") {
      return render(reply, session, tid, {
        flash: alertTestOk
          ? "Test notification sent."
          : acknowledgedNoAlertMode
            ? "Continuing without a notification channel."
            : "Test notification failed. Check the webhook URL and try again.",
        flashTone: alertTestOk || acknowledgedNoAlertMode ? "success" : "error",
      });
    }

    // Activate monitoring for all configured workflows
    const configs = selectedWorkflowConfigs(draft);
    if (configs.length === 0) {
      return render(reply, session, tid, {
        flash: "No workflows configured to activate.",
      });
    }

    const updatedConfigs: Record<string, OnboardingWorkflowConfig> =
      Object.fromEntries(
        configs.map((config) => [config.externalWorkflowId, config]),
      );
    const failures: string[] = [];
    const outcomeSetups: Array<{
      workflowName: string;
      workflowId: string;
      keyId: string;
      secret: string;
      ingestPath: string;
    }> = [];

    for (const cfg of configs) {
      if (cfg.alreadyMonitored && cfg.contractId) {
        continue;
      }
      try {
        let workflow =
          core.findWorkflowByExternalId(tid, cfg.externalWorkflowId) ?? null;
        if (!workflow) {
          workflow = core.createWorkflow(tid, {
            id: createId(),
            clientId: draft.clientId ?? null,
            name: cfg.name,
            externalWorkflowId: cfg.externalWorkflowId,
            description: null,
            monitoringMethod: cfg.monitoringMethod,
            isActive: false,
            monitoringStartedAt: null,
          });
        }
        if (cfg.monitoringMethod === "poll" && draft.connectorId) {
          n8nConnectors.bindWorkflowConnector(
            tid,
            workflow.id,
            draft.connectorId,
          );
        }

        const existingContract = deps.sqlite
          .prepare(
            `SELECT id FROM workflow_contracts
             WHERE tenant_id = ? AND workflow_id = ?
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(tid, workflow.id) as { id: string } | undefined;

        let contractId = existingContract?.id;
        const emptyPolicy = cfg.monitorEmptyResult ? "failure" : "allowed";
        const maxQuiet =
          cfg.cadenceType === "event_driven"
            ? Math.round((cfg.quietHours ?? 24) * 60)
            : cfg.monitorMissingRuns
              ? null
              : null;
        if (!contractId) {
          const created = core.createWorkflowContract(tid, {
            id: createId(),
            workflowId: workflow.id,
            name: `${cfg.name} monitoring`,
            businessPurpose: `Monitor ${cfg.name}`,
            contractType: "heartbeat",
            cadenceType: cfg.cadenceType,
            cadenceValue: cfg.cadenceValue,
            intervalMode: cfg.cadenceType === "interval" ? "fixed_rate" : null,
            scheduleAnchorAt: cfg.cadenceType === "interval" ? nowIso : null,
            timezone: cfg.timezone ?? "UTC",
            allowedLatenessMinutes: 5,
            maxQuietWindowMinutes:
              cfg.cadenceType === "event_driven" ? maxQuiet : null,
            initialGraceMinutes: 5,
            emptyResultPolicy: emptyPolicy,
            countLessSuccessAllowed: !cfg.monitorEmptyResult,
            notificationBackoffMinutes: 30,
            evidenceLevel: "basic",
            schemaVersion: 1,
            isActive: false,
            activatedAt: null,
          });
          contractId = created.id;
        } else {
          // Explicit onboarding choices replace an older inactive contract's
          // defaults. Already-protected workflows never enter this flow.
          deps.sqlite
            .prepare(
              `UPDATE workflow_contracts
               SET cadence_type = ?, cadence_value = ?, interval_mode = ?,
                   schedule_anchor_at = ?, timezone = ?,
                   max_quiet_window_minutes = ?, empty_result_policy = ?,
                   count_less_success_allowed = ?,
                   updated_at = ?
               WHERE tenant_id = ? AND id = ?`,
            )
            .run(
              cfg.cadenceType,
              cfg.cadenceValue,
              cfg.cadenceType === "interval" ? "fixed_rate" : null,
              cfg.cadenceType === "interval" ? nowIso : null,
              cfg.timezone ?? "UTC",
              cfg.cadenceType === "event_driven" ? maxQuiet : null,
              emptyPolicy,
              cfg.monitorEmptyResult ? 0 : 1,
              nowIso,
              tid,
              contractId,
            );
        }

        if (channelId) {
          try {
            alerting.routeContractToChannel(tid, {
              contractKind: "workflow",
              contractId,
              alertChannelId: channelId,
            });
          } catch {
            // route may already exist
          }
        }

        const routes = alerting.listRoutesForContract(
          tid,
          "workflow",
          contractId,
        );
        const testedRoute = routes.some((r) => {
          const st = alerting.getAlertChannelState(tid, r.alertChannelId);
          return (
            st?.currentHealth === "healthy" ||
            st?.lastSuccessAt != null ||
            st?.lastTestedAt != null
          );
        });

        const contractRow = deps.sqlite
          .prepare(
            `SELECT * FROM workflow_contracts WHERE tenant_id = ? AND id = ?`,
          )
          .get(tid, contractId) as Record<string, unknown>;

        const validation = validateWorkflowContract(
          {
            workflowId: workflow.id,
            name: String(contractRow.name),
            businessPurpose: String(contractRow.business_purpose),
            contractType: "heartbeat",
            cadenceType: contractRow.cadence_type as CadenceType,
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
            allowedLatenessMinutes: Number(
              contractRow.allowed_lateness_minutes,
            ),
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
            evidenceLevel: "basic",
            schemaVersion: 1,
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
          failures.push(
            `${cfg.name}: ${validation.issues.map((i) => i.message).join(" ")}`,
          );
          continue;
        }

        deps.sqlite
          .prepare(
            `UPDATE workflow_contracts
             SET is_active = 1, activated_at = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(nowIso, nowIso, tid, contractId);
        deps.sqlite
          .prepare(
            `UPDATE workflows
             SET is_active = 1, monitoring_method = ?,
                 monitoring_started_at = COALESCE(monitoring_started_at, ?), updated_at = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(cfg.monitoringMethod, nowIso, nowIso, tid, workflow.id);

        if (
          cfg.monitorVolumeRange &&
          volume.listActiveVolumeRulesForContract(tid, contractId).length === 0
        ) {
          volume.createVolumeRule(tid, {
            id: createId(),
            workflowContractId: contractId,
            minimumCount: cfg.volumeMin ?? 0,
            maximumCount: cfg.volumeMax,
            windowType: "daily",
            timezone: cfg.timezone ?? "UTC",
            weekStartsOn: null,
            evaluationGraceMinutes: 5,
            violationSeverity: "warning",
            activatedAt: nowIso,
          });
        }

        if (cfg.monitoringMethod === "push") {
          const activeCredential = deps.sqlite
            .prepare(
              `SELECT id FROM workflow_credentials
               WHERE tenant_id = ? AND workflow_id = ? AND status = 'active'
               LIMIT 1`,
            )
            .get(tid, workflow.id) as { id: string } | undefined;
          if (!activeCredential) {
            const secret = randomBytes(32).toString("base64url");
            const keyId = `key_${createId().slice(0, 12)}`;
            const credentialId = createId();
            core.createCredential(tid, {
              id: credentialId,
              workflowId: workflow.id,
              keyId,
              encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
                secret,
                deps.env.QUORUM_CREDENTIAL_KEK,
              ),
              status: "active",
              rotatedFromId: null,
              revokedAt: null,
            });
            opsAudit.recordOpsAudit({
              tenantId: tid,
              actorUserId: session.adminUserId,
              action: "credential.created",
              resourceType: "workflow_credential",
              resourceId: credentialId,
              details: { workflowId: workflow.id, keyId },
              nowIso,
            });
            outcomeSetups.push({
              workflowName: cfg.name,
              workflowId: workflow.id,
              keyId,
              secret,
              ingestPath: `/api/v1/workflows/${workflow.id}/heartbeats`,
            });
          }
        }

        const refreshedContractRow = deps.sqlite
          .prepare(
            `SELECT * FROM workflow_contracts WHERE tenant_id = ? AND id = ?`,
          )
          .get(tid, contractId) as Record<string, unknown>;
        const nextExpected = computeNextExpectedIso({
          contract: refreshedContractRow,
          lastReportAt: nowIso,
          clock: deps.clock,
        });
        const existingState = core.getWorkflowState(tid, workflow.id);
        core.upsertWorkflowState(tid, {
          tenantId: tid,
          workflowId: workflow.id,
          lastExecutionAt: existingState?.lastExecutionAt ?? null,
          lastNonemptySuccessAt: existingState?.lastNonemptySuccessAt ?? null,
          lastAcceptableSuccessAt:
            existingState?.lastAcceptableSuccessAt ?? null,
          lastFailureAt: existingState?.lastFailureAt ?? null,
          lastExternalExecutionRef:
            existingState?.lastExternalExecutionRef ?? null,
          lastStatus: existingState?.lastStatus ?? "unknown",
          nextExpectedAt: nextExpected,
          overdueSince: null,
          currentHealth: "unknown",
          evidenceLevel: "basic",
          evidenceSummaryCode: existingState?.evidenceSummaryCode ?? null,
          unverifiedDimensionsJson:
            existingState?.unverifiedDimensionsJson ?? null,
          consecutiveStaleChecks: existingState?.consecutiveStaleChecks ?? 0,
          updatedAt: nowIso,
        });

        opsAudit.recordOpsAudit({
          tenantId: tid,
          actorUserId: session.adminUserId,
          action: "contract.activated",
          resourceType: "workflow_contract",
          resourceId: contractId,
          nowIso,
        });

        updatedConfigs[cfg.externalWorkflowId] = {
          ...cfg,
          workflowId: workflow.id,
          contractId,
        };
      } catch (error) {
        failures.push(
          `${cfg.name}: ${error instanceof Error ? error.message : "activation failed"}`,
        );
      }
    }

    if (draft.clientId) {
      core.updateClientStatus(tid, draft.clientId, "protected", nowIso, nowIso);
    }

    const finalDraft: OnboardingDraft = {
      ...draft,
      workflowConfigs: updatedConfigs,
      activatedAt: nowIso,
    };
    onboarding.setStep(tid, "complete", nowIso, { draft: finalDraft });

    if (failures.length > 0) {
      return render(reply, session, tid, {
        flash: `Some workflows could not be activated: ${failures.join(" · ")}`,
      });
    }
    if (outcomeSetups.length > 0) {
      return render(reply, session, tid, {
        outcomeSetups,
        flash:
          "Monitoring is active. Complete the Outcome monitoring reporter setup and send a test heartbeat.",
        flashTone: "success",
      });
    }
    return reply.redirect("/onboarding");
  });

  app.post("/onboarding/finish", async (request, reply) => {
    const session = deps.requireSession(request, reply);
    if (
      !session ||
      !deps.requireAdmin(session, reply) ||
      !deps.assertCsrf(request, session, reply)
    ) {
      return;
    }
    onboarding.complete(deps.tenantId(), deps.clock.now().toISOString());
    return reply.redirect("/catalog");
  });
}
