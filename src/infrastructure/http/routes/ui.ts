import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { Clock } from "../../../domain/clock.js";
import { createId } from "../../../domain/ids.js";
import { queryContractCatalog } from "../../catalog/query-catalog.js";
import { isUiOpenWithoutLogin, type QuorumEnv } from "../../config/env.js";
import { SqliteAlertingRepositories } from "../../db/repositories/sqlite-alerting-repositories.js";
import { SqliteAuthRepositories } from "../../db/repositories/sqlite-auth-repositories.js";
import { SqliteCoreRepositories } from "../../db/repositories/sqlite-core-repositories.js";
import { SqliteOpsAuditRepositories } from "../../db/repositories/sqlite-ops-audit-repositories.js";
import { SqliteN8nConnectorRepositories } from "../../db/repositories/sqlite-n8n-connector-repositories.js";
import { SqliteOnboardingRepositories } from "../../db/repositories/sqlite-onboarding-repositories.js";
import { SqliteOutboundDestinationRepositories } from "../../db/repositories/sqlite-outbound-destinations.js";
import {
  encryptCredentialSecret,
  decryptCredentialSecret,
} from "../../security/credential-secrets.js";
import { resolveIdentifierHmacKey } from "../../security/identifier-hmac.js";
import {
  clearOpenCsrfCookieHeader,
  clearSessionCookieHeader,
  OPEN_CSRF_COOKIE,
  openCsrfCookieHeader,
  parseCookieHeader,
  SESSION_COOKIE,
  sessionCookieHeader,
} from "../cookies.js";
import { registerSimplifiedOnboardingRoutes } from "./ui-onboarding-routes.js";
import {
  renderAlertsPage,
  renderCredentialOncePage,
  renderLoginPage,
  renderNetworkPrivacyPage,
  renderOutcomeEvidencePage,
  renderSetupPage,
  renderWorkflowsPage,
} from "../../../presentation/html/pages.js";
import type { createOutboxProcessor } from "../../alerting/process-outbox.js";
import { SqliteOutcomeContractRepositories } from "../../db/repositories/sqlite-outcome-contract-repositories.js";
import { SqliteReconciliationRepositories } from "../../db/repositories/sqlite-reconciliation-repositories.js";
import { createReconciliationRunner } from "../../connectors/run-reconciliation.js";
import { validateN8nConnectorConnectivity } from "../../n8n/n8n-api-client.js";
import {
  generateOpaqueToken,
  hashToken,
} from "../../../domain/auth/passwords.js";
import { registerProductUiRoutes } from "./ui-product-routes.js";
import {
  validateWorkflowRegistrationInput,
  workflowRegistrationErrorMessage,
} from "../ui-form-errors.js";

const SESSION_MAX_AGE_S = 12 * 60 * 60;

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

export function registerUiRoutes(
  app: FastifyInstance,
  deps: {
    env: QuorumEnv;
    sqlite: Database.Database;
    clock: Clock;
    processOutbox?: ReturnType<typeof createOutboxProcessor>;
  },
): void {
  const auth = new SqliteAuthRepositories(deps.sqlite);
  const core = new SqliteCoreRepositories(deps.sqlite);
  const onboarding = new SqliteOnboardingRepositories(deps.sqlite);
  const outbound = new SqliteOutboundDestinationRepositories(deps.sqlite);
  const alerting = new SqliteAlertingRepositories(deps.sqlite);
  const opsAudit = new SqliteOpsAuditRepositories(deps.sqlite);
  const n8nConnectors = new SqliteN8nConnectorRepositories(deps.sqlite);
  const secureCookie = deps.env.NODE_ENV === "production";
  const pageShell = { demoMode: deps.env.QUORUM_DEMO_MODE };

  function tenantId(): string {
    return core.ensureSelfHostedTenant().id;
  }

  function readSession(request: FastifyRequest): Session | null {
    const cookies = parseCookieHeader(
      typeof request.headers.cookie === "string"
        ? request.headers.cookie
        : undefined,
    );
    const sessionId = cookies[SESSION_COOKIE];
    if (!sessionId) {
      return null;
    }
    return auth.getSession(sessionId, deps.clock.now());
  }

  function openModeSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Session {
    const cookies = parseCookieHeader(
      typeof request.headers.cookie === "string"
        ? request.headers.cookie
        : undefined,
    );
    let csrf = cookies[OPEN_CSRF_COOKIE];
    if (!csrf || csrf.length < 16) {
      csrf = randomBytes(24).toString("hex");
      reply.header(
        "set-cookie",
        openCsrfCookieHeader(csrf, {
          secure: secureCookie,
          maxAgeSeconds: SESSION_MAX_AGE_S,
        }),
      );
    }
    return {
      adminUserId: "local-open",
      csrfToken: csrf,
      role: "admin",
    };
  }

  function requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Session | null {
    if (isUiOpenWithoutLogin(deps.env)) {
      const existing = readSession(request);
      return existing ?? openModeSession(request, reply);
    }
    if (!auth.hasAdminUser()) {
      void reply.redirect("/setup");
      return null;
    }
    const session = readSession(request);
    if (!session) {
      void reply.redirect("/login");
      return null;
    }
    return session;
  }

  function assertCsrf(
    request: FastifyRequest,
    session: Session,
    reply: FastifyReply,
  ): boolean {
    const body = formBody(request);
    const header = request.headers["x-csrf-token"];
    const token =
      body.csrf ?? (typeof header === "string" ? header : undefined);
    if (!token || token !== session.csrfToken) {
      void reply.code(403).type("text/html").send("CSRF validation failed");
      return false;
    }
    return true;
  }

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

  function setSessionCookie(reply: FastifyReply, sessionId: string): void {
    reply.header(
      "set-cookie",
      sessionCookieHeader(sessionId, {
        secure: secureCookie,
        maxAgeSeconds: SESSION_MAX_AGE_S,
      }),
    );
  }

  app.get("/", async (request, reply) => {
    if (!isUiOpenWithoutLogin(deps.env) && !auth.hasAdminUser()) {
      return reply.redirect("/setup");
    }
    const session = requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = tenantId();
    if (!onboarding.isComplete(tid)) {
      return reply.redirect("/onboarding");
    }
    return reply.redirect("/catalog");
  });

  registerProductUiRoutes(app, {
    env: deps.env,
    sqlite: deps.sqlite,
    clock: deps.clock,
    ...(deps.processOutbox ? { processOutbox: deps.processOutbox } : {}),
    requireSession,
    assertCsrf,
    tenantId,
  });

  app.get("/setup", async (_request, reply) => {
    if (isUiOpenWithoutLogin(deps.env)) {
      return reply.redirect("/");
    }
    if (auth.hasAdminUser()) {
      return reply.redirect("/login");
    }
    return reply.type("text/html").send(renderSetupPage({ ...pageShell }));
  });

  app.post("/setup", async (request, reply) => {
    if (isUiOpenWithoutLogin(deps.env)) {
      return reply.redirect("/");
    }
    if (auth.hasAdminUser()) {
      return reply.redirect("/login");
    }
    const body = formBody(request);
    const result = auth.createAdminWithSetupToken({
      setupToken: body.setupToken ?? "",
      username: body.username ?? "",
      password: body.password ?? "",
      now: deps.clock.now(),
    });
    if (!result.ok) {
      return reply
        .type("text/html")
        .send(renderSetupPage({ ...pageShell, flash: result.code }));
    }
    const tid = tenantId();
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: result.adminId,
      action: "admin.setup_completed",
      resourceType: "admin_user",
      resourceId: result.adminId,
      details: { username: body.username ?? "" },
      nowIso: deps.clock.now().toISOString(),
    });
    onboarding.ensure(tid, deps.clock.now().toISOString());
    return reply.redirect("/login");
  });

  app.get("/login", async (_request, reply) => {
    if (isUiOpenWithoutLogin(deps.env)) {
      return reply.redirect("/");
    }
    if (!auth.hasAdminUser()) {
      return reply.redirect("/setup");
    }
    return reply.type("text/html").send(renderLoginPage({ ...pageShell }));
  });

  app.post("/login", async (request, reply) => {
    if (isUiOpenWithoutLogin(deps.env)) {
      return reply.redirect("/");
    }
    const body = formBody(request);
    const ip =
      (typeof request.headers["x-forwarded-for"] === "string"
        ? request.headers["x-forwarded-for"].split(",")[0]?.trim()
        : null) ??
      request.ip ??
      "local";
    const result = auth.tryLogin({
      username: body.username ?? "",
      password: body.password ?? "",
      ipKey: ip,
      now: deps.clock.now(),
    });
    if (!result.ok) {
      return reply
        .type("text/html")
        .send(renderLoginPage({ ...pageShell, flash: result.code }));
    }
    setSessionCookie(reply, result.sessionId);
    const tid = tenantId();
    if (!onboarding.isComplete(tid)) {
      return reply.redirect("/onboarding");
    }
    return reply.redirect("/catalog");
  });

  app.get("/logout", async (request, reply) => {
    const cookies = parseCookieHeader(
      typeof request.headers.cookie === "string"
        ? request.headers.cookie
        : undefined,
    );
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) {
      auth.destroySession(sessionId);
    }
    reply.header("set-cookie", [
      clearSessionCookieHeader(secureCookie),
      clearOpenCsrfCookieHeader(secureCookie),
    ]);
    if (isUiOpenWithoutLogin(deps.env)) {
      return reply.redirect("/");
    }
    return reply.redirect("/login");
  });

  app.get("/network-privacy", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return;
    }
    return reply.type("text/html").send(
      renderNetworkPrivacyPage({
        ...pageShell,
        destinations: outbound.list(tenantId()),
      }),
    );
  });

  registerSimplifiedOnboardingRoutes(app, {
    env: deps.env,
    sqlite: deps.sqlite,
    clock: deps.clock,
    ...(deps.processOutbox ? { processOutbox: deps.processOutbox } : {}),
    requireSession,
    assertCsrf,
    requireAdmin,
    tenantId,
    demoMode: pageShell.demoMode === true,
  });

  app.get("/workflows", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = tenantId();
    const query = request.query as {
      registered?: string;
      error?: string;
    };
    const flash =
      query.registered === "1"
        ? "Workflow registered. Copy the Quorum workflow ID from the table for push setup (not the n8n workflow ID). For Connect n8n, bind a connector next. Inactive means no active contract yet — push heartbeats then return CONTRACT_NOT_ACTIVE."
        : query.error === "duplicate"
          ? "A workflow with this n8n workflow ID is already registered for this organization. Use a different ID, or open the existing workflow below."
          : query.error === "validation"
            ? "Workflow name and n8n workflow ID are required."
            : null;
    const flashTone =
      query.registered === "1" ? ("success" as const) : ("error" as const);
    const workflows = deps.sqlite
      .prepare(
        `SELECT id, name, external_workflow_id, monitoring_method, is_active, connector_id
         FROM workflows WHERE tenant_id = ? ORDER BY created_at DESC`,
      )
      .all(tid) as Array<{
      id: string;
      name: string;
      external_workflow_id: string;
      monitoring_method: string;
      is_active: number;
      connector_id: string | null;
    }>;
    const connectors = deps.sqlite
      .prepare(
        `SELECT id, name FROM n8n_connectors
         WHERE tenant_id = ? AND status = 'active'
         ORDER BY name ASC`,
      )
      .all(tid) as Array<{ id: string; name: string }>;
    return reply.type("text/html").send(
      renderWorkflowsPage({
        ...pageShell,
        csrf: session.csrfToken,
        connectors,
        flash,
        flashTone,
        workflows: workflows.map((w) => ({
          id: w.id,
          name: w.name,
          externalWorkflowId: w.external_workflow_id,
          monitoringMethod: w.monitoring_method,
          isActive: w.is_active === 1,
          connectorId: w.connector_id,
        })),
      }),
    );
  });

  app.post("/workflows/:workflowId/connector", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const workflowId = (request.params as { workflowId: string }).workflowId;
    const body = formBody(request);
    const connectorId = body.connectorId ?? "";
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    try {
      n8nConnectors.bindWorkflowConnector(tid, workflowId, connectorId);
    } catch {
      return reply.code(404).type("text/html").send("Workflow not found");
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "workflow.connector_bound",
      resourceType: "workflow",
      resourceId: workflowId,
      details: { connectorId },
      nowIso,
    });
    return reply.redirect("/workflows");
  });

  app.post("/workflows", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const name = (body.name ?? "").trim();
    const externalWorkflowId = (body.externalWorkflowId ?? "").trim();
    const monitoringMethod = body.monitoringMethod === "push" ? "push" : "poll";
    const validationError = validateWorkflowRegistrationInput({
      name,
      externalWorkflowId,
    });

    const renderWith = (flash: string, tone: "error" | "success" = "error") => {
      const tid = tenantId();
      const workflows = deps.sqlite
        .prepare(
          `SELECT id, name, external_workflow_id, monitoring_method, is_active, connector_id
           FROM workflows WHERE tenant_id = ? ORDER BY created_at DESC`,
        )
        .all(tid) as Array<{
        id: string;
        name: string;
        external_workflow_id: string;
        monitoring_method: string;
        is_active: number;
        connector_id: string | null;
      }>;
      const connectors = deps.sqlite
        .prepare(
          `SELECT id, name FROM n8n_connectors
           WHERE tenant_id = ? AND status = 'active'
           ORDER BY name ASC`,
        )
        .all(tid) as Array<{ id: string; name: string }>;
      return reply
        .code(tone === "error" ? 400 : 200)
        .type("text/html")
        .send(
          renderWorkflowsPage({
            ...pageShell,
            csrf: session.csrfToken,
            connectors,
            flash,
            flashTone: tone,
            draft: { name, externalWorkflowId, monitoringMethod },
            workflows: workflows.map((w) => ({
              id: w.id,
              name: w.name,
              externalWorkflowId: w.external_workflow_id,
              monitoringMethod: w.monitoring_method,
              isActive: w.is_active === 1,
              connectorId: w.connector_id,
            })),
          }),
        );
    };

    if (validationError) {
      return renderWith(validationError);
    }

    try {
      core.createWorkflow(tenantId(), {
        id: createId(),
        clientId: null,
        name,
        externalWorkflowId,
        description: null,
        monitoringMethod,
        isActive: false,
        monitoringStartedAt: null,
      });
    } catch (error) {
      return renderWith(workflowRegistrationErrorMessage(error));
    }
    return reply.redirect("/workflows?registered=1");
  });

  app.post("/workflows/:workflowId/credentials", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const workflowId = (request.params as { workflowId: string }).workflowId;
    const secret = randomBytes(32).toString("base64url");
    const keyId = `key_${createId().slice(0, 12)}`;
    const credentialId = createId();
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    core.createCredential(tid, {
      id: credentialId,
      workflowId,
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
      details: { workflowId, keyId },
      nowIso,
    });
    return reply.type("text/html").send(
      renderCredentialOncePage({
        ...pageShell,
        workflowId,
        keyId,
        secret,
        ingestPath: `/api/v1/workflows/${workflowId}/heartbeats`,
      }),
    );
  });

  app.post(
    "/workflows/:workflowId/credentials/:credentialId/rotate",
    async (request, reply) => {
      const session = requireSession(request, reply);
      if (
        !session ||
        !requireAdmin(session, reply) ||
        !assertCsrf(request, session, reply)
      ) {
        return;
      }
      const { workflowId, credentialId } = request.params as {
        workflowId: string;
        credentialId: string;
      };
      const tid = tenantId();
      const nowIso = deps.clock.now().toISOString();
      const secret = randomBytes(32).toString("base64url");
      const keyId = `key_${createId().slice(0, 12)}`;
      const newId = createId();
      try {
        const rotated = core.rotateCredential(tid, {
          workflowId,
          previousCredentialId: credentialId,
          newCredential: {
            id: newId,
            workflowId,
            keyId,
            encryptedSecretOrVerificationMaterial: encryptCredentialSecret(
              secret,
              deps.env.QUORUM_CREDENTIAL_KEK,
            ),
          },
          nowIso,
        });
        opsAudit.recordOpsAudit({
          tenantId: tid,
          actorUserId: session.adminUserId,
          action: "credential.rotated",
          resourceType: "workflow_credential",
          resourceId: rotated.next.id,
          details: {
            workflowId,
            previousCredentialId: rotated.previous.id,
            keyId,
          },
          nowIso,
        });
        return reply.type("text/html").send(
          renderCredentialOncePage({
            ...pageShell,
            workflowId,
            keyId,
            secret,
            ingestPath: `/api/v1/workflows/${workflowId}/heartbeats`,
          }),
        );
      } catch {
        return reply.code(404).type("text/html").send("Credential not found");
      }
    },
  );

  app.post(
    "/workflows/:workflowId/credentials/:credentialId/revoke",
    async (request, reply) => {
      const session = requireSession(request, reply);
      if (
        !session ||
        !requireAdmin(session, reply) ||
        !assertCsrf(request, session, reply)
      ) {
        return;
      }
      const { workflowId, credentialId } = request.params as {
        workflowId: string;
        credentialId: string;
      };
      const tid = tenantId();
      const nowIso = deps.clock.now().toISOString();
      const revoked = core.revokeCredential(tid, credentialId, nowIso);
      if (!revoked) {
        return reply.code(404).type("text/html").send("Credential not found");
      }
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "credential.revoked",
        resourceType: "workflow_credential",
        resourceId: credentialId,
        details: { workflowId },
        nowIso,
      });
      return reply.redirect("/workflows");
    },
  );

  app.post("/contracts/:contractId/cadence", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const contractId = (request.params as { contractId: string }).contractId;
    const body = formBody(request);
    const cadenceType =
      body.cadenceType === "cron" || body.cadenceType === "event_driven"
        ? body.cadenceType
        : "interval";
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const ok = core.updateWorkflowContractCadence(tid, contractId, {
      cadenceType,
      cadenceValue: body.cadenceValue ?? "15",
      nowIso,
    });
    if (!ok) {
      return reply.code(404).type("text/html").send("Contract not found");
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "contract.cadence_changed",
      resourceType: "workflow_contract",
      resourceId: contractId,
      details: { cadenceType, cadenceValue: body.cadenceValue ?? "15" },
      nowIso,
    });
    return reply.redirect(`/catalog/contracts/${body.workflowId ?? ""}`);
  });

  app.post("/contracts/:contractId/deactivate", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const contractId = (request.params as { contractId: string }).contractId;
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const ok = core.deactivateWorkflowContract(tid, contractId, nowIso);
    if (!ok) {
      return reply.code(404).type("text/html").send("Contract not found");
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "contract.deactivated",
      resourceType: "workflow_contract",
      resourceId: contractId,
      nowIso,
    });
    return reply.redirect("/catalog");
  });

  app.get("/alerts", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return;
    }
    const tid = tenantId();
    const channels = deps.sqlite
      .prepare(
        `SELECT c.id, c.name, c.type, COALESCE(s.current_health, 'unknown') AS health
         FROM alert_channels c
         LEFT JOIN alert_channel_states s
           ON s.tenant_id = c.tenant_id AND s.alert_channel_id = c.id
         WHERE c.tenant_id = ?
         ORDER BY c.created_at DESC`,
      )
      .all(tid) as Array<{
      id: string;
      name: string;
      type: string;
      health: string;
    }>;
    return reply.type("text/html").send(
      renderAlertsPage({
        ...pageShell,
        csrf: session.csrfToken,
        channels,
      }),
    );
  });

  app.post("/alerts", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const channelId = createId();
    const url = body.url ?? "";
    alerting.createAlertChannel(tid, {
      id: channelId,
      name: body.name ?? "Webhook",
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
      label: body.name ?? "Webhook",
      destination: url,
      nowIso,
    });
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "alert_channel.created",
      resourceType: "alert_channel",
      resourceId: channelId,
      details: { type: "webhook", name: body.name ?? "Webhook" },
      nowIso,
    });
    return reply.redirect("/alerts");
  });

  app.post("/alerts/:channelId/test", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const channelId = (request.params as { channelId: string }).channelId;
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const channel = alerting.getAlertChannel(tid, channelId);
    if (channel) {
      try {
        const cfg = JSON.parse(
          decryptCredentialSecret(
            channel.encryptedConfig,
            deps.env.QUORUM_CREDENTIAL_KEK,
          ),
        ) as { url?: string };
        if (cfg.url) {
          outbound.recordAttempt({
            tenantId: tid,
            kind: "webhook",
            destination: cfg.url,
            status: "success",
            nowIso,
          });
        }
      } catch {
        // ignore bad config
      }
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
    return reply.redirect("/alerts");
  });

  app.post("/alerts/:channelId/disable", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const channelId = (request.params as { channelId: string }).channelId;
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const ok = alerting.disableAlertChannel(tid, channelId, nowIso);
    if (!ok) {
      return reply.code(404).type("text/html").send("Alert channel not found");
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "alert_channel.disabled",
      resourceType: "alert_channel",
      resourceId: channelId,
      nowIso,
    });
    return reply.redirect("/alerts");
  });

  app.post("/connectors/n8n", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const body = formBody(request);
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const apiKey = body.apiKey ?? "";
    try {
      const connector = n8nConnectors.createConnector(tid, {
        name: body.name ?? "n8n",
        baseUrl: body.baseUrl ?? "http://127.0.0.1:5678",
        encryptedApiKey: encryptCredentialSecret(
          apiKey,
          deps.env.QUORUM_CREDENTIAL_KEK,
        ),
        nowIso,
        enforcePublicUrl: false,
        status: "active",
      });
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "connector.created",
        resourceType: "n8n_connector",
        resourceId: connector.id,
        details: { name: connector.name, baseUrl: connector.baseUrl },
        nowIso,
      });
      return reply.redirect("/connectors");
    } catch (error) {
      return reply
        .code(400)
        .type("text/html")
        .send(String(error instanceof Error ? error.message : error));
    }
  });

  app.post(
    "/connectors/n8n/:connectorId/credential",
    async (request, reply) => {
      const session = requireSession(request, reply);
      if (
        !session ||
        !requireAdmin(session, reply) ||
        !assertCsrf(request, session, reply)
      ) {
        return;
      }
      const connectorId = (request.params as { connectorId: string })
        .connectorId;
      const body = formBody(request);
      const tid = tenantId();
      const nowIso = deps.clock.now().toISOString();
      const ok = n8nConnectors.updateConnectorCredential(tid, connectorId, {
        encryptedApiKey: encryptCredentialSecret(
          body.apiKey ?? "",
          deps.env.QUORUM_CREDENTIAL_KEK,
        ),
        nowIso,
      });
      if (!ok) {
        return reply.code(404).type("text/html").send("Connector not found");
      }
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "connector.credential_updated",
        resourceType: "n8n_connector",
        resourceId: connectorId,
        nowIso,
      });
      return reply.redirect("/connectors");
    },
  );

  app.post("/connectors/n8n/:connectorId/disable", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const connectorId = (request.params as { connectorId: string }).connectorId;
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const ok = n8nConnectors.disableConnector(tid, connectorId, nowIso);
    if (!ok) {
      return reply.code(404).type("text/html").send("Connector not found");
    }
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "connector.disabled",
      resourceType: "n8n_connector",
      resourceId: connectorId,
      nowIso,
    });
    return reply.redirect("/connectors");
  });

  app.post("/connectors/n8n/:connectorId/test", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const connectorId = (request.params as { connectorId: string }).connectorId;
    const tid = tenantId();
    const nowIso = deps.clock.now().toISOString();
    const connector = n8nConnectors.getConnector(tid, connectorId);
    if (!connector) {
      return reply.code(404).type("text/html").send("Connector not found");
    }

    let apiKey: string;
    try {
      apiKey = decryptCredentialSecret(
        connector.encryptedApiKey,
        deps.env.QUORUM_CREDENTIAL_KEK,
      );
    } catch {
      n8nConnectors.updateConnectorHealth(tid, connectorId, {
        health: "misconfigured",
        checkedAtIso: nowIso,
        errorCode: "decrypt_failed",
        errorSummary: "connector_secret_unavailable",
      });
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "connector.tested",
        resourceType: "n8n_connector",
        resourceId: connectorId,
        details: { ok: false, code: "decrypt_failed" },
        nowIso,
      });
      return reply.redirect("/connectors?tested=fail");
    }

    const result = await validateN8nConnectorConnectivity(
      { baseUrl: connector.baseUrl, apiKey },
      {
        connectTimeoutMs: deps.env.N8N_CONNECTOR_CONNECT_TIMEOUT_MS,
        readTimeoutMs: deps.env.N8N_CONNECTOR_READ_TIMEOUT_MS,
        maxResponseBytes: deps.env.N8N_CONNECTOR_MAX_RESPONSE_BYTES,
        maxRedirects: deps.env.N8N_CONNECTOR_MAX_REDIRECTS,
        networkPolicy: "self_hosted_local",
      },
    );

    if (!result.ok) {
      n8nConnectors.updateConnectorHealth(tid, connectorId, {
        health: result.health,
        checkedAtIso: nowIso,
        errorCode: result.code,
        errorSummary: result.summary,
      });
      opsAudit.recordOpsAudit({
        tenantId: tid,
        actorUserId: session.adminUserId,
        action: "connector.tested",
        resourceType: "n8n_connector",
        resourceId: connectorId,
        details: { ok: false, code: result.code },
        nowIso,
      });
      return reply.redirect("/connectors?tested=fail");
    }

    n8nConnectors.updateConnectorHealth(tid, connectorId, {
      health: "healthy",
      checkedAtIso: nowIso,
      success: true,
      errorCode: null,
      errorSummary: null,
    });
    opsAudit.recordOpsAudit({
      tenantId: tid,
      actorUserId: session.adminUserId,
      action: "connector.tested",
      resourceType: "n8n_connector",
      resourceId: connectorId,
      details: { ok: true },
      nowIso,
    });
    return reply.redirect("/connectors?tested=ok");
  });

  app.get("/catalog/outcome/:id", async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const tid = tenantId();
    const outcomeContracts = new SqliteOutcomeContractRepositories(deps.sqlite);
    const recon = new SqliteReconciliationRepositories(deps.sqlite);
    const contract = outcomeContracts.get(tid, id);
    if (!contract) {
      return reply.code(404).type("text/html").send("Not found");
    }
    const catalog = queryContractCatalog({
      sqlite: deps.sqlite,
      clock: deps.clock,
      tenantId: tid,
      publicBaseUrl: deps.env.PUBLIC_BASE_URL,
    });
    const row = catalog.find((c) => c.contractId === id);
    const latest = recon.latestRunForContract(tid, id);
    const items = latest ? recon.listItems(tid, latest.id) : [];
    const waitingCount = items.filter(
      (i) => i.matchStatus === "waiting",
    ).length;
    return reply.type("text/html").send(
      renderOutcomeEvidencePage({
        ...pageShell,
        csrf: session.csrfToken,
        contractId: id,
        businessPurpose: contract.businessPurpose,
        evidenceLevel: row?.evidenceLevel ?? "basic",
        evidenceStale: row?.evidenceStale ?? false,
        lastVerifiedWindow: row?.lastVerifiedWindow ?? null,
        run: latest
          ? {
              id: latest.id,
              status: latest.status,
              sourceCount: latest.sourceCount,
              destinationCount: latest.destinationCount,
              matchedCount: latest.matchedCount,
              missingCount: latest.missingCount,
              duplicateCount: latest.duplicateCount,
              lateCount: latest.lateCount,
              waitingCount,
              evidenceLevelAchieved: latest.evidenceLevelAchieved,
            }
          : null,
        items: items.map((i) => ({
          matchStatus: i.matchStatus,
          sourceIdentifierHash: i.sourceIdentifierHash,
        })),
        incidentSummary: row?.activeIncident?.summary ?? null,
      }),
    );
  });

  app.post("/catalog/outcome/:id/export", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const body = formBody(request);
    const tid = tenantId();
    const recon = new SqliteReconciliationRepositories(deps.sqlite);
    const runId = body.runId ?? recon.latestRunForContract(tid, id)?.id;
    if (!runId) {
      return reply.redirect(`/catalog/outcome/${id}`);
    }
    const token = generateOpaqueToken(24);
    const now = deps.clock.now();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    recon.createExportToken({
      tokenHash: hashToken(token),
      tenantId: tid,
      outcomeContractId: id,
      reconciliationRunId: runId,
      createdAt: now.toISOString(),
      expiresAt,
    });
    recon.recordAudit({
      tenantId: tid,
      outcomeContractId: id,
      reconciliationRunId: runId,
      eventType: "export",
      actor: session.adminUserId,
      createdAt: now.toISOString(),
      expiresAt,
      detailsJson: JSON.stringify({ scope: "missing_hashes" }),
    });
    return reply.type("text/html").send(layoutExportOnce(token, expiresAt, id));
  });

  app.post("/catalog/outcome/:id/waive", async (request, reply) => {
    const session = requireSession(request, reply);
    if (
      !session ||
      !requireAdmin(session, reply) ||
      !assertCsrf(request, session, reply)
    ) {
      return;
    }
    const id = (request.params as { id: string }).id;
    const runner = createReconciliationRunner({
      sqlite: deps.sqlite,
      clock: deps.clock,
      kek: deps.env.QUORUM_CREDENTIAL_KEK,
      identifierHmacKey: resolveIdentifierHmacKey(deps.env),
      http: {
        connectTimeoutMs: deps.env.N8N_CONNECTOR_CONNECT_TIMEOUT_MS,
        readTimeoutMs: deps.env.N8N_CONNECTOR_READ_TIMEOUT_MS,
        maxResponseBytes: deps.env.N8N_CONNECTOR_MAX_RESPONSE_BYTES,
        maxRedirects: deps.env.N8N_CONNECTOR_MAX_REDIRECTS,
      },
    });
    runner.waiveMissing({
      tenantId: tenantId(),
      outcomeContractId: id,
      actor: session.adminUserId,
    });
    return reply.redirect(`/catalog/outcome/${id}`);
  });
}

function layoutExportOnce(
  token: string,
  expiresAt: string,
  contractId: string,
): string {
  return `<!doctype html><html><body>
    <h1>Export token (shown once)</h1>
    <p>Expires at ${expiresAt}. Use GET /api/v1/outcome/exports/${token}</p>
    <p><code>${token}</code></p>
    <p><a href="/catalog/outcome/${contractId}">Back</a></p>
  </body></html>`;
}
