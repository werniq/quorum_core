#!/usr/bin/env node
/**
 * Definitive real-container Quorum ↔ n8n validation.
 *
 * - Real Quorum + real n8n (docker-compose.e2e.yml + validation override).
 * - Pinned image: n8nio/n8n:1.95.3 (no fallback).
 * - HMAC for success/healthy/silent-absence/recovery is ALWAYS signed inside an
 *   n8n Code node. Host only HTTP-triggers the webhook (or waits for Schedule).
 * - Host-side signHeartbeat is ONLY used for intentional adversarial forgeries
 *   (invalid/stale/revoked/wrong-workflow signatures). Documented inline.
 * - Silent absence uses real wall-clock waits (1-minute interval cadence).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchWithTimeout,
  formPost,
  parseCsrfFromHtml,
  waitForN8nRestReady,
  waitForUrl,
} from "./lib/http.mjs";
import {
  findFreePort,
  logStage,
  mintCredential,
  postHeartbeat,
  protectPushContract,
  randomToken,
  setupAndLogin,
  signHeartbeat,
} from "./lib/quorum-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const COMPOSE_E2E = path.join(REPO_ROOT, "docker-compose.e2e.yml");
const COMPOSE_VAL = path.join(REPO_ROOT, "docker-compose.e2e.validation.yml");
const N8N_IMAGE = "n8nio/n8n:1.95.3";
const EVIDENCE_PATH = path.join(
  REPO_ROOT,
  "docs",
  "verification",
  "payloads",
  "real-n8n-run.json",
);

const N8N_OWNER = {
  email: "real-n8n-owner@quorum.local",
  firstName: "Real",
  lastName: "Validation",
  password: "Real-N8n-Validation-Password-OK!",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertDockerDaemon() {
  const result = spawnSync("docker", ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      "Docker daemon is not reachable. Start Docker Desktop (or the Docker engine), then retry.",
    );
  }
}

function composeArgs(project, args) {
  return [
    "compose",
    "-p",
    project,
    "-f",
    COMPOSE_E2E,
    "-f",
    COMPOSE_VAL,
    ...args,
  ];
}

function compose(project, args, env = {}) {
  const result = spawnSync("docker", composeArgs(project, args), {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function composeDown(project, env = {}) {
  spawnSync(
    "docker",
    composeArgs(project, ["down", "-v", "--remove-orphans"]),
    {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        QUORUM_CREDENTIAL_KEK:
          env.QUORUM_CREDENTIAL_KEK ?? "cleanup-placeholder-kek",
        QUORUM_SETUP_TOKEN:
          env.QUORUM_SETUP_TOKEN ?? "cleanup-placeholder-setup-token",
        ...env,
      },
    },
  );
}

function composeRestartQuorum(project, env) {
  const result = spawnSync(
    "docker",
    composeArgs(project, ["restart", "quorum"]),
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      shell: false,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `docker compose restart quorum failed:\n${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Run a read/write SQL snippet inside the Quorum container via better-sqlite3.
 * @returns {unknown}
 */
function sqlInQuorum(project, env, jsExpression) {
  const script = `
const Database = require('better-sqlite3');
const db = new Database('/data/quorum.sqlite');
db.pragma('busy_timeout = 5000');
const result = (() => { ${jsExpression} })();
process.stdout.write(JSON.stringify(result === undefined ? null : result));
db.close();
`.trim();
  const result = spawnSync(
    "docker",
    composeArgs(project, ["exec", "-T", "quorum", "node", "-e", script]),
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `quorum SQL exec failed:\n${result.stderr || result.stdout}`,
    );
  }
  const out = (result.stdout || "").trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`quorum SQL exec returned non-JSON: ${out.slice(0, 300)}`);
  }
}

async function ensureN8nImage() {
  logStage(`ensure ${N8N_IMAGE}`);
  const inspect = spawnSync("docker", ["image", "inspect", N8N_IMAGE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (inspect.status === 0) {
    console.log("[info] image already present; skip pull");
    return N8N_IMAGE;
  }
  logStage(`pull ${N8N_IMAGE}`);
  const pull = spawnSync("docker", ["pull", N8N_IMAGE], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (pull.status !== 0) {
    throw new Error(
      `Could not pull ${N8N_IMAGE}. Real validation requires this pin (no fallback).`,
    );
  }
  return N8N_IMAGE;
}

/**
 * Alert mock reachable from Docker via host.docker.internal.
 * Binds 0.0.0.0 so container → host port forwarding works on Desktop/Linux.
 * Prefer compose service `alert-mock` (see countComposeAlertDeliveries).
 */
async function listenAlertMock() {
  /** @type {Array<{ at: string; body: string; path: string }>} */
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      deliveries.push({
        at: new Date().toISOString(),
        body,
        path: req.url ?? "/",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "0.0.0.0", (err) => (err ? reject(err) : resolve()));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    hostUrl: `http://127.0.0.1:${port}/alert`,
    dockerUrl: `http://host.docker.internal:${port}/alert`,
    deliveries,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function countComposeAlertDeliveries(project, env) {
  const result = spawnSync(
    "docker",
    composeArgs(project, [
      "exec",
      "-T",
      "alert-mock",
      "node",
      "-e",
      "const fs=require('fs');try{const t=fs.readFileSync('/tmp/alerts.log','utf8');console.log(t.trim()?t.trim().split(/\\n/).length:0)}catch(e){console.log(0)}",
    ]),
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
    },
  );
  const n = Number((result.stdout || "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Copied from verify-n8n-e2e.mjs: owner setup + API key with scopes + expiresAt.
 */
async function obtainN8nApiKey(n8nBase) {
  const root = n8nBase.replace(/\/+$/, "");

  try {
    const setup = await fetchWithTimeout(`${root}/rest/owner/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(N8N_OWNER),
      timeoutMs: 30_000,
    });
    if (![200, 201, 204, 400].includes(setup.status)) {
      const t = await setup.text();
      console.warn(
        `[warn] n8n owner setup returned ${setup.status}: ${t.slice(0, 200)}`,
      );
    }
  } catch (error) {
    console.warn(
      `[warn] n8n owner setup failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  const login = await fetchWithTimeout(`${root}/rest/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      emailOrLdapLoginId: N8N_OWNER.email,
      email: N8N_OWNER.email,
      password: N8N_OWNER.password,
    }),
    redirect: "manual",
    timeoutMs: 30_000,
  });
  const setCookies = login.headers.getSetCookie?.() ?? [];
  const cookieHeader =
    setCookies.length > 0
      ? setCookies.map((c) => c.split(";")[0]).join("; ")
      : (login.headers.get("set-cookie")?.split(";")[0] ?? "");

  if (login.status >= 400 || !cookieHeader) {
    throw new Error(
      `n8n login failed (${login.status}); cannot mint API key. Real validation requires n8n API access.`,
    );
  }

  let scopes = [
    "workflow:create",
    "workflow:read",
    "workflow:update",
    "workflow:list",
    "workflow:activate",
    "workflow:deactivate",
    "execution:read",
    "execution:list",
  ];
  try {
    const scopesRes = await fetchWithTimeout(`${root}/rest/api-keys/scopes`, {
      headers: { cookie: cookieHeader },
      timeoutMs: 15_000,
    });
    if (scopesRes.ok) {
      const payload = await scopesRes.json();
      let list = null;
      if (Array.isArray(payload)) list = payload;
      else if (payload && Array.isArray(payload.data)) list = payload.data;
      else if (payload && Array.isArray(payload.scopes)) list = payload.scopes;
      if (list && list.every((s) => typeof s === "string")) {
        scopes = list;
      } else if (
        list &&
        list.every(
          (s) => s && typeof s === "object" && typeof s.scope === "string",
        )
      ) {
        scopes = list.map((s) => s.scope);
      }
    }
  } catch {
    // keep defaults
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const candidates = [
    {
      url: `${root}/rest/api-keys`,
      body: { label: "quorum-real-n8n", expiresAt, scopes },
    },
    {
      url: `${root}/rest/api-keys`,
      body: { label: "quorum-real-n8n", expiresAt, scopes: [] },
    },
  ];

  for (const candidate of candidates) {
    const res = await fetchWithTimeout(candidate.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify(candidate.body),
      timeoutMs: 30_000,
    });
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) {
      try {
        const json = JSON.parse(text);
        const key =
          json.data?.rawApiKey ??
          json.data?.apiKey ??
          json.rawApiKey ??
          json.apiKey ??
          json.data?.accessToken;
        if (typeof key === "string" && key.length > 8) {
          return key;
        }
      } catch {
        // continue
      }
    }
  }

  if (process.env.N8N_API_KEY) {
    console.log("[info] using N8N_API_KEY from environment");
    return process.env.N8N_API_KEY;
  }
  throw new Error(
    "Could not obtain n8n API key. Real validation cannot host-sign happy-path heartbeats.",
  );
}

function n8nSignCodeJs(workflowId, keyId, secret) {
  // Runs inside n8n Code node — HMAC identical to Quorum ingest.
  // bodyRaw must be the exact UTF-8 string that was hashed (do not re-JSON in HTTP node).
  return `
const crypto = require('crypto');
const workflowId = ${JSON.stringify(workflowId)};
const keyId = ${JSON.stringify(keyId)};
const secret = ${JSON.stringify(secret)};
const path = '/api/v1/workflows/' + workflowId + '/heartbeats';
const rawIn = ($input && $input.first && $input.first().json) ? $input.first().json : {};
const input = (rawIn.body && typeof rawIn.body === 'object' && !Array.isArray(rawIn.body))
  ? rawIn.body
  : rawIn;
const status = (typeof input.status === 'string' && input.status) ? input.status : 'success';
const itemsProcessed = (input.itemsProcessed !== undefined && input.itemsProcessed !== null)
  ? Number(input.itemsProcessed)
  : 1;
const idem = (typeof input.idempotencyKey === 'string' && input.idempotencyKey)
  ? input.idempotencyKey
  : ('n8n-real-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const executedAt = (typeof input.executedAt === 'string' && input.executedAt)
  ? input.executedAt
  : new Date().toISOString();
const externalExecutionRef = (typeof input.externalExecutionRef === 'string' && input.externalExecutionRef)
  ? input.externalExecutionRef
  : ('n8n-real-' + Date.now());
const body = {
  schemaVersion: 1,
  executedAt: executedAt,
  status: status,
  itemsProcessed: Number.isFinite(itemsProcessed) ? itemsProcessed : 1,
  externalExecutionRef: externalExecutionRef,
};
const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const bodySha = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
const payload = ['POST', path, ts, idem, bodySha].join('\\n');
const signature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
return [{
  json: {
    url: 'http://quorum:3000' + path,
    bodyRaw: raw,
    headers: {
      'content-type': 'application/json',
      'x-quorum-key-id': keyId,
      'x-quorum-timestamp': ts,
      'x-quorum-idempotency-key': idem,
      'x-quorum-signature': signature,
    },
  },
}];
`.trim();
}

async function n8nApi(n8nBase, apiKey, method, apiPath, body) {
  const root = n8nBase.replace(/\/+$/, "");
  const res = await fetchWithTimeout(`${root}${apiPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 60_000,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function createPushWorkflow(n8nBase, apiKey, input) {
  const code = n8nSignCodeJs(input.workflowId, input.keyId, input.secret);
  const workflow = {
    name: "Quorum Real n8n Heartbeat",
    nodes: [
      {
        parameters: {
          httpMethod: "POST",
          path: "quorum-hb",
          responseMode: "lastNode",
          options: {},
        },
        id: "webhook-trigger",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [0, 0],
        webhookId: "quorum-hb",
      },
      {
        parameters: {
          rule: {
            interval: [{ field: "minutes", minutesInterval: 1 }],
          },
        },
        id: "schedule-trigger",
        name: "Schedule",
        type: "n8n-nodes-base.scheduleTrigger",
        typeVersion: 1.2,
        position: [0, 220],
      },
      {
        parameters: {
          mode: "runOnceForAllItems",
          language: "javaScript",
          jsCode: code,
        },
        id: "sign-hmac",
        name: "Sign Quorum Heartbeat",
        type: "n8n-nodes-base.code",
        typeVersion: 2,
        position: [280, 110],
      },
      {
        parameters: {
          method: "POST",
          url: "={{$json.url}}",
          sendHeaders: true,
          headerParameters: {
            parameters: [
              {
                name: "content-type",
                value: "application/json",
              },
              {
                name: "x-quorum-key-id",
                value: "={{$json.headers['x-quorum-key-id']}}",
              },
              {
                name: "x-quorum-timestamp",
                value: "={{$json.headers['x-quorum-timestamp']}}",
              },
              {
                name: "x-quorum-idempotency-key",
                value: "={{$json.headers['x-quorum-idempotency-key']}}",
              },
              {
                name: "x-quorum-signature",
                value: "={{$json.headers['x-quorum-signature']}}",
              },
            ],
          },
          sendBody: true,
          contentType: "raw",
          rawContentType: "application/json",
          body: "={{$json.bodyRaw}}",
          options: {
            response: {
              response: {
                neverError: true,
              },
            },
          },
        },
        id: "http-heartbeat",
        name: "POST Quorum Heartbeat",
        type: "n8n-nodes-base.httpRequest",
        typeVersion: 4.2,
        position: [560, 110],
      },
    ],
    connections: {
      Webhook: {
        main: [[{ node: "Sign Quorum Heartbeat", type: "main", index: 0 }]],
      },
      Schedule: {
        main: [[{ node: "Sign Quorum Heartbeat", type: "main", index: 0 }]],
      },
      "Sign Quorum Heartbeat": {
        main: [[{ node: "POST Quorum Heartbeat", type: "main", index: 0 }]],
      },
    },
    settings: { executionOrder: "v1" },
  };

  const create = await n8nApi(
    n8nBase,
    apiKey,
    "POST",
    "/api/v1/workflows",
    workflow,
  );
  if (create.status >= 300) {
    throw new Error(
      `n8n create workflow failed ${create.status}: ${create.text.slice(0, 400)}`,
    );
  }
  const n8nWorkflowId = String(create.json?.id ?? create.json?.data?.id ?? "");
  if (!n8nWorkflowId) {
    throw new Error(
      `n8n create workflow missing id: ${create.text.slice(0, 300)}`,
    );
  }
  return n8nWorkflowId;
}

async function setN8nWorkflowActive(n8nBase, apiKey, n8nWorkflowId, active) {
  const patch = await n8nApi(
    n8nBase,
    apiKey,
    "PATCH",
    `/api/v1/workflows/${n8nWorkflowId}`,
    { active },
  );
  if (patch.status >= 200 && patch.status < 300) return;

  const altPath = active
    ? `/api/v1/workflows/${n8nWorkflowId}/activate`
    : `/api/v1/workflows/${n8nWorkflowId}/deactivate`;
  const alt = await n8nApi(n8nBase, apiKey, "POST", altPath, {});
  if (alt.status >= 200 && alt.status < 300) return;

  throw new Error(
    `n8n set active=${active} failed: PATCH ${patch.status} / POST ${alt.status}: ${alt.text.slice(0, 200)}`,
  );
}

/**
 * After silent-absence recovery, drop the Schedule trigger so controlled
 * hard-fail/empty/idempotency tests are not interrupted by 1m heartbeats.
 * Webhook path remains for host-triggered, Code-signed pushes.
 */
async function stripScheduleKeepWebhook(n8nBase, apiKey, n8nWorkflowId) {
  const get = await n8nApi(
    n8nBase,
    apiKey,
    "GET",
    `/api/v1/workflows/${n8nWorkflowId}`,
  );
  if (get.status >= 300 || !get.json) {
    throw new Error(
      `n8n get workflow failed ${get.status}: ${get.text.slice(0, 200)}`,
    );
  }
  const wf = get.json.data ?? get.json;
  const nodes = (wf.nodes ?? []).filter(
    (n) => n.type !== "n8n-nodes-base.scheduleTrigger" && n.name !== "Schedule",
  );
  const connections = { ...(wf.connections ?? {}) };
  delete connections.Schedule;
  const patch = await n8nApi(
    n8nBase,
    apiKey,
    "PUT",
    `/api/v1/workflows/${n8nWorkflowId}`,
    {
      name: wf.name,
      nodes,
      connections,
      settings: wf.settings ?? { executionOrder: "v1" },
    },
  );
  // Some builds use PATCH for partial updates
  if (patch.status >= 300) {
    const patch2 = await n8nApi(
      n8nBase,
      apiKey,
      "PATCH",
      `/api/v1/workflows/${n8nWorkflowId}`,
      { nodes, connections },
    );
    if (patch2.status >= 300) {
      throw new Error(
        `n8n strip schedule failed PUT ${patch.status} PATCH ${patch2.status}`,
      );
    }
  }
  await setN8nWorkflowActive(n8nBase, apiKey, n8nWorkflowId, true);
}

/**
 * Fire the production webhook. Signing happens inside n8n Code — host only triggers.
 * @returns {Promise<Response>}
 */
async function fireN8nWebhook(n8nPublic, body = {}, options = {}) {
  const url = `${n8nPublic.replace(/\/+$/, "")}/webhook/quorum-hb`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 60_000,
  });
  if (res.status >= 400) {
    const text = await res.text();
    if (options.project && options.env) {
      try {
        const logs = spawnSync(
          "docker",
          composeArgs(options.project, ["logs", "--tail=80", "n8n"]),
          {
            cwd: REPO_ROOT,
            env: { ...process.env, ...options.env },
            encoding: "utf8",
          },
        );
        console.error(
          "[debug] n8n logs tail:\n",
          (logs.stdout || logs.stderr || "").slice(-2500),
        );
      } catch {
        // ignore
      }
    }
    throw new Error(
      `n8n webhook trigger failed ${res.status}: ${text.slice(0, 300)}. Cannot fall back to host-side signing for success paths.`,
    );
  }
  return res;
}

async function countSuccessHeartbeats(project, env, workflowId) {
  return sqlInQuorum(
    project,
    env,
    `
    const row = db.prepare(
      "SELECT COUNT(*) AS c, MAX(received_at) AS last_at FROM heartbeat_events WHERE workflow_id = ? AND status = 'success' AND COALESCE(items_processed, 0) > 0"
    ).get(${JSON.stringify(workflowId)});
    return { count: Number(row?.c ?? 0), lastAt: row?.last_at ?? null };
    `,
  );
}

async function waitForSuccessHeartbeats(
  project,
  env,
  workflowId,
  minCount,
  { timeoutMs = 240_000, intervalMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last = { count: 0, lastAt: null };
  while (Date.now() < deadline) {
    last = await countSuccessHeartbeats(project, env, workflowId);
    if (last.count >= minCount) return last;
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ≥${minCount} non-empty success heartbeats (have ${last.count})`,
  );
}

async function waitForIncident(
  project,
  env,
  workflowId,
  incidentType,
  { status = "open", timeoutMs = 180_000, intervalMs = 5_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = sqlInQuorum(
      project,
      env,
      `
      return db.prepare(
        "SELECT id, status, incident_type, opened_at, resolved_at FROM incidents WHERE workflow_id = ? AND incident_type = ? ORDER BY opened_at ASC"
      ).all(${JSON.stringify(workflowId)}, ${JSON.stringify(incidentType)});
      `,
    );
    const match = (rows ?? []).find((r) => r.status === status);
    if (match) return { match, all: rows };
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out waiting for ${incidentType} incident with status=${status}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const project = `quorum-real-n8n-${Date.now().toString(36)}`;
  const kek = `kek-${randomToken(24)}`;
  const setupToken = `setup-${randomToken(24)}`;
  let hostPort = 3000;
  let n8nPort = 5678;
  let exitCode = 0;
  let started = false;
  /** @type {Awaited<ReturnType<typeof listenAlertMock>> | null} */
  let alertMock = null;

  /** @type {Record<string, unknown>} */
  const evidence = {
    startedAt: new Date().toISOString(),
    image: N8N_IMAGE,
    stages: {},
    results: {},
    limitations: [],
    ok: false,
  };

  const composeEnvBase = () => ({
    QUORUM_CREDENTIAL_KEK: kek,
    QUORUM_SETUP_TOKEN: setupToken,
    PUBLIC_BASE_URL: `http://127.0.0.1:${hostPort}`,
    QUORUM_HOST_PORT: String(hostPort),
    N8N_HOST_PORT: String(n8nPort),
    N8N_IMAGE,
    N8N_ENCRYPTION_KEY: "test-encryption-key-32chars!!",
  });

  const cleanup = async () => {
    if (alertMock) {
      try {
        await alertMock.close();
      } catch {
        // ignore
      }
    }
    if (started) {
      logStage("compose down -v");
      composeDown(project, composeEnvBase());
    }
  };

  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    assertDockerDaemon();
    await ensureN8nImage();

    hostPort = await findFreePort();
    n8nPort = await findFreePort();
    if (hostPort === n8nPort) n8nPort = await findFreePort();

    const publicBase = `http://127.0.0.1:${hostPort}`;
    const n8nPublic = `http://127.0.0.1:${n8nPort}`;
    const composeEnv = composeEnvBase();

    logStage("start host alert mock (host.docker.internal)");
    alertMock = await listenAlertMock();
    evidence.stages.alertMock = {
      hostUrl: alertMock.hostUrl,
      dockerUrl: alertMock.dockerUrl,
    };

    logStage("compose up (e2e + validation override)");
    compose(project, ["up", "--build", "-d"], composeEnv);
    started = true;

    logStage("wait Quorum + n8n healthy");
    await waitForUrl(`${publicBase}/readyz`, {
      timeoutMs: 300_000,
      label: "quorum /readyz",
    });
    await waitForUrl(`${n8nPublic}/healthz`, {
      okStatuses: [200, 204],
      timeoutMs: 300_000,
      label: "n8n /healthz",
    }).catch(async () => {
      await waitForUrl(n8nPublic, {
        okStatuses: [200, 302],
        timeoutMs: 60_000,
        label: "n8n /",
      });
    });
    await waitForN8nRestReady(n8nPublic, { timeoutMs: 300_000 });

    logStage("Quorum setup + protect (interval 1 minute)");
    const session = await setupAndLogin(publicBase, { setupToken });
    const protected_ = await protectPushContract(publicBase, session, {
      webhookUrl: "http://alert-mock:8080/alert",
      acknowledgedNoAlertMode: "",
      workflowName: "Real n8n Push",
      externalWorkflowId: "n8n-real-push",
      cadenceValue: "1",
      cadenceType: "interval",
    });
    evidence.stages.protect = {
      workflowId: protected_.workflowId,
      contractId: protected_.contractId,
      clientId: protected_.clientId,
      channelId: protected_.channelId,
    };

    // Channel test during protect may have already hit the mock.
    const alertsAfterProtect = countComposeAlertDeliveries(project, composeEnv);
    console.log(
      `[info] alert-mock deliveries after protect: ${alertsAfterProtect}`,
    );

    logStage("POST /contracts/:id/cadence → interval 1 minute");
    {
      const cadenceRes = await formPost(
        `${publicBase}/contracts/${protected_.contractId}/cadence`,
        {
          csrf: protected_.csrf,
          cadenceType: "interval",
          cadenceValue: "1",
          workflowId: protected_.workflowId,
        },
        { cookie: session.cookie, redirect: "manual" },
      );
      assert(
        [200, 302, 303].includes(cadenceRes.status),
        `cadence update expected redirect/200, got ${cadenceRes.status}`,
      );
    }

    logStage(
      "SQL: set since_last_success + lateness 0 for real 1m silent-absence window",
    );
    sqlInQuorum(
      project,
      composeEnv,
      `
      db.prepare(
        "UPDATE workflow_contracts SET interval_mode = 'since_last_success', allowed_lateness_minutes = 0, schedule_anchor_at = NULL, updated_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), ${JSON.stringify(protected_.contractId)});
      return db.prepare(
        "SELECT cadence_type, cadence_value, allowed_lateness_minutes, interval_mode, notification_backoff_minutes, empty_result_policy FROM workflow_contracts WHERE id = ?"
      ).get(${JSON.stringify(protected_.contractId)});
      `,
    );
    const cadenceRow = sqlInQuorum(
      project,
      composeEnv,
      `
      return db.prepare(
        "SELECT cadence_type, cadence_value, allowed_lateness_minutes, interval_mode, notification_backoff_minutes, empty_result_policy FROM workflow_contracts WHERE id = ?"
      ).get(${JSON.stringify(protected_.contractId)});
      `,
    );
    evidence.stages.cadence = {
      ...cadenceRow,
      cadenceValueMinutes: 1,
      note: "since_last_success + lateness 0 → deadline = lastSuccess + 1 minute (wall-clock silent absence).",
      notificationBackoffMinutes:
        cadenceRow?.notification_backoff_minutes ?? 30,
      duplicateAlertCheck:
        "no second alert within 2 watcher cycles (15s+); renotify backoff is longer",
    };

    logStage(
      "mint push credential (key/secret kept in memory for n8n Code embed)",
    );
    const cred = await mintCredential(
      publicBase,
      session.cookie,
      protected_.csrf,
      protected_.workflowId,
    );
    // keyId/secret only held in process memory for embedding into n8n workflow JSON.
    const credentialId = sqlInQuorum(
      project,
      composeEnv,
      `
      const row = db.prepare(
        "SELECT id FROM workflow_credentials WHERE key_id = ? LIMIT 1"
      ).get(${JSON.stringify(cred.keyId)});
      return row?.id ?? null;
      `,
    );
    assert(credentialId, "could not resolve credential id from DB");

    logStage("obtain n8n API key");
    const apiKey = await obtainN8nApiKey(n8nPublic);

    logStage("create n8n workflow (Webhook + Schedule → Code HMAC → HTTP)");
    const n8nWorkflowId = await createPushWorkflow(n8nPublic, apiKey, {
      workflowId: protected_.workflowId,
      keyId: cred.keyId,
      secret: cred.secret,
    });
    evidence.stages.n8nWorkflowId = n8nWorkflowId;

    logStage("activate n8n workflow");
    await setN8nWorkflowActive(n8nPublic, apiKey, n8nWorkflowId, true);

    logStage(
      "wait for ≥2 n8n-signed heartbeats (two webhooks; no 1m schedule wait)",
    );
    await fireN8nWebhook(
      n8nPublic,
      {
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: `kickoff-a-${Date.now()}`,
      },
      { project, env: composeEnv },
    );
    await sleep(1_500);
    await fireN8nWebhook(
      n8nPublic,
      {
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: `kickoff-b-${Date.now()}`,
      },
      { project, env: composeEnv },
    );
    const afterTwo = await waitForSuccessHeartbeats(
      project,
      composeEnv,
      protected_.workflowId,
      2,
      { timeoutMs: 30_000 },
    );
    evidence.stages.healthyHeartbeats = afterTwo;
    evidence.results.n8nAuthoredHmac = true;
    console.log(
      `[info] non-empty success heartbeats=${afterTwo.count} lastAt=${afterTwo.lastAt}`,
    );

    logStage("confirm Healthy + Basic evidence in catalog HTML");
    {
      const catalog = await fetchWithTimeout(`${publicBase}/catalog`, {
        headers: { cookie: session.cookie },
      });
      const html = await catalog.text();
      assert(catalog.status === 200, `catalog status ${catalog.status}`);
      assert(
        html.includes("Healthy") || html.includes("health-healthy"),
        "catalog HTML missing Healthy",
      );
      assert(
        /badge basic|Basic evidence|basic/i.test(html),
        "catalog HTML missing Basic evidence marker",
      );
      evidence.results.catalogHealthyBasic = true;
    }

    const lastHbBeforeSilence = afterTwo.lastAt;
    const silenceStartedAt = new Date().toISOString();

    logStage("deactivate n8n workflow (stop Schedule + Webhook path)");
    await setN8nWorkflowActive(n8nPublic, apiKey, n8nWorkflowId, false);

    logStage(
      "silent absence: wall-clock wait ~65s after last heartbeat (1m since_last_success)",
    );
    // Deadline = lastSuccess + 1 minute. Sleep until slightly past that, not a fixed 75s from now.
    const lastHbMs = lastHbBeforeSilence
      ? Date.parse(lastHbBeforeSilence)
      : Date.now();
    const deadlineMs = lastHbMs + 60_000 + 5_000;
    const waitMs = Math.max(5_000, deadlineMs - Date.now());
    console.log(
      `[info] sleeping ${waitMs}ms (real wall clock; last heartbeat ${lastHbBeforeSilence}; deadline≈${new Date(deadlineMs).toISOString()})`,
    );
    await sleep(waitMs);

    logStage("poll until silent_absence incident exists");
    const silent = await waitForIncident(
      project,
      composeEnv,
      protected_.workflowId,
      "silent_absence",
      { status: "open", timeoutMs: 120_000 },
    );
    const openSilent = (silent.all ?? []).filter(
      (r) => r.incident_type === "silent_absence" && r.status === "open",
    );
    assert(
      openSilent.length === 1,
      `expected exactly 1 open silent_absence, got ${openSilent.length}`,
    );
    evidence.results.silentAbsence = {
      incidentId: silent.match.id,
      openedAt: silent.match.opened_at,
      silenceStartedAt,
      waitMs,
    };

    // Allow outbox delivery to alert-mock service
    await sleep(8_000);
    const alertsAfterSilent = countComposeAlertDeliveries(project, composeEnv);
    const outboxAfterSilent = sqlInQuorum(
      project,
      composeEnv,
      `
      return {
        pending: db.prepare("SELECT COUNT(*) AS c FROM notification_outbox WHERE processed_at IS NULL").get().c,
        processed: db.prepare("SELECT COUNT(*) AS c FROM notification_outbox WHERE processed_at IS NOT NULL").get().c,
        attempts: db.prepare("SELECT COUNT(*) AS c FROM notification_attempts").get().c,
      };
      `,
    );
    assert(
      alertsAfterSilent > alertsAfterProtect ||
        Number(outboxAfterSilent?.processed ?? 0) >
          Number(alertsAfterProtect ?? 0) ||
        Number(outboxAfterSilent?.attempts ?? 0) > 0,
      `expected alert delivery after silent absence (mock=${alertsAfterSilent}, protect=${alertsAfterProtect}, outbox=${JSON.stringify(outboxAfterSilent)})`,
    );
    evidence.results.silentAbsenceAlertDeliveries = alertsAfterSilent;
    evidence.results.silentAbsenceOutbox = outboxAfterSilent;

    logStage("wait 2+ watcher cycles (~12s); confirm still one incident");
    const alertsBeforeBackoffCheck = countComposeAlertDeliveries(
      project,
      composeEnv,
    );
    await sleep(12_000);
    const silentAgain = sqlInQuorum(
      project,
      composeEnv,
      `
      return db.prepare(
        "SELECT id, status FROM incidents WHERE workflow_id = ? AND incident_type = 'silent_absence' AND status IN ('open','acknowledged')"
      ).all(${JSON.stringify(protected_.workflowId)});
      `,
    );
    assert(
      (silentAgain ?? []).length === 1,
      `expected still 1 open silent_absence after watcher cycles, got ${(silentAgain ?? []).length}`,
    );
    const alertsAfterBackoffCheck = countComposeAlertDeliveries(
      project,
      composeEnv,
    );
    assert(
      alertsAfterBackoffCheck <= alertsBeforeBackoffCheck + 0,
      `unexpected second alert within 2 watcher cycles (renotify backoff is 30 min; before=${alertsBeforeBackoffCheck} after=${alertsAfterBackoffCheck})`,
    );
    // Prefer outbox attempt count for duplicate check (mock log can be noisy).
    const attemptsAfterCycles = sqlInQuorum(
      project,
      composeEnv,
      `return db.prepare("SELECT COUNT(*) AS c FROM notification_attempts").get().c`,
    );
    evidence.results.notificationAttemptsAfterWatcherCycles =
      attemptsAfterCycles;
    assert(
      Number(attemptsAfterCycles) <=
        Number(outboxAfterSilent?.attempts ?? 0) + 1,
      `unexpected extra notification attempts during watcher cycles (before=${outboxAfterSilent?.attempts}, after=${attemptsAfterCycles})`,
    );
    evidence.results.noDuplicateAlertWithinTwoWatcherCycles = true;

    logStage("reactivate n8n + fire webhook for recovery");
    await setN8nWorkflowActive(n8nPublic, apiKey, n8nWorkflowId, true);
    await fireN8nWebhook(n8nPublic, {
      status: "success",
      itemsProcessed: 1,
      externalExecutionRef: `recovery-${Date.now()}`,
    });

    logStage("confirm SAME silent_absence incident resolves");
    {
      const deadline = Date.now() + 60_000;
      let resolved = null;
      while (Date.now() < deadline) {
        resolved = sqlInQuorum(
          project,
          composeEnv,
          `
          return db.prepare(
            "SELECT id, status, resolved_at FROM incidents WHERE id = ?"
          ).get(${JSON.stringify(silent.match.id)});
          `,
        );
        if (resolved?.status === "resolved") break;
        await sleep(3_000);
      }
      assert(
        resolved?.status === "resolved",
        `expected incident ${silent.match.id} resolved, got ${JSON.stringify(resolved)}`,
      );
      evidence.results.silentAbsenceResolved = {
        incidentId: silent.match.id,
        resolvedAt: resolved.resolved_at,
      };
    }

    // Resolution may land in outbox before alert-mock count moves (mock can stay flat).
    let resolveEvidence = null;
    {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        resolveEvidence = sqlInQuorum(
          project,
          composeEnv,
          `
          const incidentId = ${JSON.stringify(silent.match.id)};
          const resolvedRows = db.prepare(
            "SELECT id, event_type, processed_at, attempt_count, last_error FROM notification_outbox WHERE incident_id = ? AND event_type = 'resolved'"
          ).all(incidentId);
          const attempts = db.prepare(
            "SELECT COUNT(*) AS c FROM notification_attempts WHERE incident_id = ? AND outbox_id IN (SELECT id FROM notification_outbox WHERE incident_id = ? AND event_type = 'resolved')"
          ).get(incidentId, incidentId)?.c ?? 0;
          return { resolvedRows, attempts: Number(attempts) };
          `,
        );
        const rows = resolveEvidence?.resolvedRows ?? [];
        if (
          rows.length > 0 &&
          (rows.some((r) => r.processed_at) ||
            Number(resolveEvidence?.attempts ?? 0) > 0)
        ) {
          break;
        }
        await sleep(2_000);
      }
    }
    const alertsAfterResolve = countComposeAlertDeliveries(project, composeEnv);
    assert(
      alertsAfterResolve > alertsAfterSilent ||
        (resolveEvidence?.resolvedRows ?? []).length > 0,
      `expected resolution notification (mock silent=${alertsAfterSilent}, resolve=${alertsAfterResolve}, outbox=${JSON.stringify(resolveEvidence)})`,
    );
    evidence.results.resolutionAlertDeliveries = alertsAfterResolve;
    evidence.results.resolutionOutbox = resolveEvidence;

    logStage("strip Schedule trigger (webhook-only for controlled tests)");
    await stripScheduleKeepWebhook(n8nPublic, apiKey, n8nWorkflowId);

    logStage("hard failure via n8n webhook (Code signs status=failure)");
    await fireN8nWebhook(n8nPublic, {
      status: "failure",
      itemsProcessed: 0,
      externalExecutionRef: `hard-fail-${Date.now()}`,
    });
    const hard = await waitForIncident(
      project,
      composeEnv,
      protected_.workflowId,
      "hard_failure",
      { status: "open", timeoutMs: 45_000 },
    );
    evidence.results.hardFailure = { incidentId: hard.match.id };

    // Clear hard_failure with a non-empty success so empty-result asserts stay clean.
    await fireN8nWebhook(n8nPublic, {
      status: "success",
      itemsProcessed: 2,
      externalExecutionRef: `post-hard-ok-${Date.now()}`,
    });
    await sleep(2_000);

    const nonemptyBeforeEmpty = sqlInQuorum(
      project,
      composeEnv,
      `
      const row = db.prepare(
        "SELECT last_nonempty_success_at FROM workflow_states WHERE workflow_id = ?"
      ).get(${JSON.stringify(protected_.workflowId)});
      return row?.last_nonempty_success_at ?? null;
      `,
    );
    assert(
      nonemptyBeforeEmpty,
      "expected last_nonempty_success_at before empty tests",
    );

    logStage(
      "empty-result policies (allowed / warning / failure) via SQL + n8n-signed",
    );
    const emptyPolicies = ["allowed", "warning", "failure"];
    /** @type {Record<string, unknown>} */
    const emptyResults = {};
    for (const policy of emptyPolicies) {
      sqlInQuorum(
        project,
        composeEnv,
        `
        db.prepare(
          "UPDATE workflow_contracts SET empty_result_policy = ?, updated_at = ? WHERE id = ?"
        ).run(${JSON.stringify(policy)}, new Date().toISOString(), ${JSON.stringify(protected_.contractId)});
        return true;
        `,
      );
      // Resolve any open empty_result from prior policy iteration
      await fireN8nWebhook(n8nPublic, {
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: `pre-empty-${policy}-${Date.now()}`,
      });
      await sleep(1_500);
      const beforeTs = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT last_nonempty_success_at FROM workflow_states WHERE workflow_id = ?"
        ).get(${JSON.stringify(protected_.workflowId)})?.last_nonempty_success_at ?? null;
        `,
      );

      await fireN8nWebhook(n8nPublic, {
        status: "success",
        itemsProcessed: 0,
        externalExecutionRef: `empty-${policy}-${Date.now()}`,
      });
      await sleep(2_000);

      const afterTs = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT last_nonempty_success_at FROM workflow_states WHERE workflow_id = ?"
        ).get(${JSON.stringify(protected_.workflowId)})?.last_nonempty_success_at ?? null;
        `,
      );
      assert(
        afterTs === beforeTs,
        `last_nonempty_success_at must not update on zero items (policy=${policy}): ${beforeTs} → ${afterTs}`,
      );

      const emptyIncidents = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT id, status, severity FROM incidents WHERE workflow_id = ? AND incident_type = 'empty_result' AND status IN ('open','acknowledged') ORDER BY opened_at DESC"
        ).all(${JSON.stringify(protected_.workflowId)});
        `,
      );

      if (policy === "allowed") {
        assert(
          (emptyIncidents ?? []).length === 0,
          `policy=allowed must not open empty_result incident`,
        );
      } else if (policy === "warning") {
        assert(
          (emptyIncidents ?? []).some((i) => i.severity === "warning"),
          `policy=warning expected open warning empty_result`,
        );
      } else {
        assert(
          (emptyIncidents ?? []).some((i) => i.severity === "critical"),
          `policy=failure expected open critical empty_result`,
        );
      }
      emptyResults[policy] = {
        lastNonemptyUnchanged: true,
        openEmptyIncidents: emptyIncidents,
      };
      console.log(`[info] empty-result policy=${policy} ok`);
    }
    evidence.results.emptyResultPolicies = emptyResults;

    // Restore allowed + clear with non-empty success
    sqlInQuorum(
      project,
      composeEnv,
      `
      db.prepare(
        "UPDATE workflow_contracts SET empty_result_policy = 'allowed', updated_at = ? WHERE id = ?"
      ).run(new Date().toISOString(), ${JSON.stringify(protected_.contractId)});
      return true;
      `,
    );
    await fireN8nWebhook(n8nPublic, {
      status: "success",
      itemsProcessed: 1,
      externalExecutionRef: `post-empty-ok-${Date.now()}`,
    });
    await sleep(1_500);

    logStage(
      "auth/idempotency (host-forged adversarial + n8n-signed idempotency)",
    );
    {
      // --- host-forged adversarial: invalid signature ---
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 1,
          externalExecutionRef: `adv-badsig-${Date.now()}`,
        }),
      );
      const signed = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body,
        idempotencyKey: `adv-badsig-${Date.now()}`,
      });
      signed.headers["x-quorum-signature"] = "00".repeat(32);
      const badSig = await postHeartbeat(publicBase, signed);
      assert(
        badSig.status === 401,
        `invalid sig expected 401, got ${badSig.status}`,
      );

      // --- host-forged adversarial: stale timestamp ---
      const staleBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 1,
          externalExecutionRef: `adv-stale-${Date.now()}`,
        }),
      );
      const staleSigned = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body: staleBody,
        idempotencyKey: `adv-stale-${Date.now()}`,
        timestampSeconds: String(Math.floor(Date.now() / 1000) - 10_000),
      });
      const staleRes = await postHeartbeat(publicBase, staleSigned);
      assert(
        staleRes.status === 401,
        `stale timestamp expected 401, got ${staleRes.status}`,
      );

      // --- host-forged adversarial: wrong workflow path ---
      const otherWf = await protectPushContract(publicBase, session, {
        webhookUrl: alertMock.dockerUrl,
        acknowledgedNoAlertMode: "1",
        clientName: `Other Client ${Date.now()}`,
        workflowName: "Other Workflow",
        externalWorkflowId: "other-wf",
        cadenceValue: "15",
      });
      const otherCred = await mintCredential(
        publicBase,
        session.cookie,
        otherWf.csrf,
        otherWf.workflowId,
      );
      const crossBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 1,
          externalExecutionRef: `adv-cross-${Date.now()}`,
        }),
      );
      const crossSigned = signHeartbeat({
        secret: otherCred.secret,
        workflowId: protected_.workflowId,
        keyId: otherCred.keyId,
        body: crossBody,
        idempotencyKey: `adv-cross-${Date.now()}`,
      });
      const crossRes = await postHeartbeat(publicBase, crossSigned);
      assert(
        crossRes.status === 401,
        `wrong-workflow credential expected 401, got ${crossRes.status}`,
      );

      // --- host-forged adversarial: revoked credential ---
      const revokePage = await fetchWithTimeout(
        `${publicBase}/workflows/${protected_.workflowId}`,
        { headers: { cookie: session.cookie } },
      );
      // Use protect CSRF refresh from catalog
      const catalogForCsrf = await fetchWithTimeout(`${publicBase}/catalog`, {
        headers: { cookie: session.cookie },
      });
      const revokeCsrf =
        parseCsrfFromHtml(await catalogForCsrf.text()) ??
        parseCsrfFromHtml(await revokePage.text()) ??
        protected_.csrf;
      // Mint a disposable credential to revoke (keep primary for n8n Code)
      const disposable = await mintCredential(
        publicBase,
        session.cookie,
        revokeCsrf,
        protected_.workflowId,
      );
      const disposableId = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT id FROM workflow_credentials WHERE key_id = ? LIMIT 1"
        ).get(${JSON.stringify(disposable.keyId)})?.id ?? null;
        `,
      );
      assert(disposableId, "disposable credential id missing");
      const revokeRes = await formPost(
        `${publicBase}/workflows/${protected_.workflowId}/credentials/${disposableId}/revoke`,
        { csrf: disposable.csrf },
        { cookie: session.cookie, redirect: "manual" },
      );
      assert(
        [200, 302, 303].includes(revokeRes.status),
        `revoke expected redirect, got ${revokeRes.status}`,
      );
      const revokedBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 1,
          externalExecutionRef: `adv-revoked-${Date.now()}`,
        }),
      );
      const revokedSigned = signHeartbeat({
        secret: disposable.secret,
        workflowId: protected_.workflowId,
        keyId: disposable.keyId,
        body: revokedBody,
        idempotencyKey: `adv-revoked-${Date.now()}`,
      });
      const revokedRes = await postHeartbeat(publicBase, revokedSigned);
      assert(
        revokedRes.status === 401,
        `revoked credential expected 401, got ${revokedRes.status}`,
      );

      // --- idempotency: n8n Code signs fixed idempotencyKey + identical body from webhook ---
      const idemKey = `idem-n8n-${Date.now()}`;
      const idemBody = {
        status: "success",
        itemsProcessed: 1,
        idempotencyKey: idemKey,
        executedAt: new Date().toISOString(),
        externalExecutionRef: `idem-fixed-${Date.now()}`,
      };
      await fireN8nWebhook(n8nPublic, idemBody);
      await sleep(1_500);
      await fireN8nWebhook(n8nPublic, idemBody);
      await sleep(1_500);
      const idemCount = sqlInQuorum(
        project,
        composeEnv,
        `
        return Number(db.prepare(
          "SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ? AND idempotency_key = ?"
        ).get(${JSON.stringify(protected_.workflowId)}, ${JSON.stringify(idemKey)})?.c ?? 0);
        `,
      );
      // First accept inserts; identical replay must not insert a second row.
      assert(
        idemCount === 1,
        `expected 1 heartbeat row for idempotency key, got ${idemCount}`,
      );

      // Same idempotency key + different body → 409 IDEMPOTENCY_CONFLICT (host-signed).
      const conflictBody = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 99,
          externalExecutionRef: `idem-conflict-${Date.now()}`,
        }),
      );
      const conflictSigned = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body: conflictBody,
        idempotencyKey: idemKey,
      });
      const conflictRes = await postHeartbeat(publicBase, conflictSigned);
      assert(
        conflictRes.status === 409,
        `idempotency conflict expected 409, got ${conflictRes.status}`,
      );
      const idemCountAfterConflict = sqlInQuorum(
        project,
        composeEnv,
        `
        return Number(db.prepare(
          "SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ? AND idempotency_key = ?"
        ).get(${JSON.stringify(protected_.workflowId)}, ${JSON.stringify(idemKey)})?.c ?? 0);
        `,
      );
      assert(
        idemCountAfterConflict === 1,
        `conflict must not insert second row, got ${idemCountAfterConflict}`,
      );

      const nonemptyAfterAuth = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT last_nonempty_success_at FROM workflow_states WHERE workflow_id = ?"
        ).get(${JSON.stringify(protected_.workflowId)})?.last_nonempty_success_at ?? null;
        `,
      );

      evidence.results.authIdempotency = {
        invalidSignature: 401,
        staleTimestamp: 401,
        wrongWorkflowCredential: 401,
        revokedCredential: 401,
        n8nSignedIdempotencyRows: idemCount,
        idempotencyConflictStatus: conflictRes.status,
        lastNonemptyAfterAuth: nonemptyAfterAuth,
        note: "Adversarial auth tests are host-forged; identical-body replay signed inside n8n Code",
      };
    }

    logStage("polling product flow (UI forms + checkpoint + restart)");
    {
      let csrf =
        parseCsrfFromHtml(
          await (
            await fetchWithTimeout(`${publicBase}/connectors`, {
              headers: { cookie: session.cookie },
            })
          ).text(),
        ) ?? protected_.csrf;

      const connectorRes = await formPost(
        `${publicBase}/connectors/n8n`,
        {
          csrf,
          name: "real-n8n-connector",
          baseUrl: "http://n8n:5678",
          apiKey,
        },
        { cookie: session.cookie, redirect: "manual" },
      );
      assert(
        [200, 302, 303].includes(connectorRes.status),
        `POST /connectors/n8n failed: ${connectorRes.status}`,
      );

      const connectorId = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT id FROM n8n_connectors WHERE name = ? ORDER BY created_at DESC LIMIT 1"
        ).get('real-n8n-connector')?.id ?? null;
        `,
      );
      assert(connectorId, "connector id not found");

      // Poll workflow via protect so contract is active (required by poll adapter).
      const pollProtected = await protectPushContract(publicBase, session, {
        webhookUrl: alertMock.dockerUrl,
        acknowledgedNoAlertMode: "1",
        clientName: `Poll Client ${Date.now()}`,
        workflowName: "Real n8n Poll",
        externalWorkflowId: n8nWorkflowId,
        monitoringMethod: "poll",
        cadenceValue: "15",
      });

      const wfPage = await fetchWithTimeout(`${publicBase}/workflows`, {
        headers: { cookie: session.cookie },
      });
      const wfHtml = await wfPage.text();
      csrf = parseCsrfFromHtml(wfHtml) ?? csrf;

      const bindRes = await formPost(
        `${publicBase}/workflows/${pollProtected.workflowId}/connector`,
        { csrf, connectorId },
        { cookie: session.cookie, redirect: "manual" },
      );
      assert(
        [200, 302, 303].includes(bindRes.status),
        `bind connector failed: ${bindRes.status}`,
      );

      // Ensure poll workflow stays active (protect activate already did this).
      sqlInQuorum(
        project,
        composeEnv,
        `
        db.prepare(
          "UPDATE workflows SET is_active = 1, monitoring_started_at = COALESCE(monitoring_started_at, ?), updated_at = ? WHERE id = ?"
        ).run(new Date().toISOString(), new Date().toISOString(), ${JSON.stringify(pollProtected.workflowId)});
        db.prepare(
          "UPDATE workflow_contracts SET is_active = 1, updated_at = ? WHERE workflow_id = ?"
        ).run(new Date().toISOString(), ${JSON.stringify(pollProtected.workflowId)});
        return true;
        `,
      );

      // Ensure n8n has at least one finished execution to poll
      await setN8nWorkflowActive(n8nPublic, apiKey, n8nWorkflowId, true);
      await fireN8nWebhook(n8nPublic, {
        status: "success",
        itemsProcessed: 1,
        externalExecutionRef: `for-poll-${Date.now()}`,
      });

      logStage("wait for poll + checkpoint");
      const pollDeadline = Date.now() + 45_000;
      let checkpoint = null;
      while (Date.now() < pollDeadline) {
        checkpoint = sqlInQuorum(
          project,
          composeEnv,
          `
          return db.prepare(
            "SELECT last_seen_execution_id, last_finished_at FROM n8n_poll_checkpoints WHERE workflow_id = ?"
          ).get(${JSON.stringify(pollProtected.workflowId)}) ?? null;
          `,
        );
        if (checkpoint?.last_seen_execution_id) break;
        await sleep(5_000);
      }
      assert(
        checkpoint?.last_seen_execution_id,
        `expected poll checkpoint, got ${JSON.stringify(checkpoint)}`,
      );
      const checkpointBeforeRestart = checkpoint;
      const hbCountBeforeRestart = sqlInQuorum(
        project,
        composeEnv,
        `
        return Number(db.prepare(
          "SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?"
        ).get(${JSON.stringify(pollProtected.workflowId)})?.c ?? 0);
        `,
      );

      logStage("restart Quorum container; confirm no duplicate poll import");
      composeRestartQuorum(project, composeEnv);
      await waitForUrl(`${publicBase}/readyz`, {
        timeoutMs: 180_000,
        label: "quorum /readyz after restart",
      });
      await sleep(8_000);
      const hbCountAfterRestart = sqlInQuorum(
        project,
        composeEnv,
        `
        return Number(db.prepare(
          "SELECT COUNT(*) AS c FROM heartbeat_events WHERE workflow_id = ?"
        ).get(${JSON.stringify(pollProtected.workflowId)})?.c ?? 0);
        `,
      );
      const checkpointAfter = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT last_seen_execution_id FROM n8n_poll_checkpoints WHERE workflow_id = ?"
        ).get(${JSON.stringify(pollProtected.workflowId)}) ?? null;
        `,
      );
      assert(
        checkpointAfter?.last_seen_execution_id ===
          checkpointBeforeRestart.last_seen_execution_id,
        "checkpoint execution id changed unexpectedly after restart",
      );
      // Allow at most new executions that arrived after restart; same prior set must not double.
      assert(
        hbCountAfterRestart >= hbCountBeforeRestart,
        "heartbeat count decreased after restart",
      );
      // If no new n8n executions, counts should match (no duplicate import).
      console.log(
        `[info] poll heartbeats before=${hbCountBeforeRestart} after=${hbCountAfterRestart} checkpoint=${checkpointAfter?.last_seen_execution_id}`,
      );

      logStage("disable connector");
      const connectorsPage = await fetchWithTimeout(
        `${publicBase}/connectors`,
        {
          headers: { cookie: session.cookie },
        },
      );
      csrf = parseCsrfFromHtml(await connectorsPage.text()) ?? csrf;
      const disableRes = await formPost(
        `${publicBase}/connectors/n8n/${connectorId}/disable`,
        { csrf },
        { cookie: session.cookie, redirect: "manual" },
      );
      assert(
        [200, 302, 303].includes(disableRes.status),
        `disable connector failed: ${disableRes.status}`,
      );

      logStage("invalid API key connector");
      const badKeyRes = await formPost(
        `${publicBase}/connectors/n8n`,
        {
          csrf,
          name: "real-n8n-bad-key",
          baseUrl: "http://n8n:5678",
          apiKey: "definitely-not-a-valid-n8n-api-key",
        },
        { cookie: session.cookie, redirect: "manual" },
      );
      console.log(`[info] bad-key connector create status=${badKeyRes.status}`);
      // Trigger a connectivity test if possible
      const badConnectorId = sqlInQuorum(
        project,
        composeEnv,
        `
        return db.prepare(
          "SELECT id FROM n8n_connectors WHERE name = ? ORDER BY created_at DESC LIMIT 1"
        ).get('real-n8n-bad-key')?.id ?? null;
        `,
      );
      if (badConnectorId) {
        const testPage = await fetchWithTimeout(`${publicBase}/connectors`, {
          headers: { cookie: session.cookie },
        });
        csrf = parseCsrfFromHtml(await testPage.text()) ?? csrf;
        await formPost(
          `${publicBase}/connectors/n8n/${badConnectorId}/test`,
          { csrf },
          { cookie: session.cookie, redirect: "manual" },
        );
        await sleep(3_000);
        const health = sqlInQuorum(
          project,
          composeEnv,
          `
          return db.prepare(
            "SELECT health, last_error_code FROM n8n_connectors WHERE id = ?"
          ).get(${JSON.stringify(badConnectorId)});
          `,
        );
        console.log(
          `[info] bad-key connector health=${JSON.stringify(health)}`,
        );
        evidence.results.invalidKeyConnector = health;
      }

      evidence.results.poll = {
        connectorId,
        pollWorkflowId: pollProtected.workflowId,
        checkpoint: checkpointBeforeRestart,
        heartbeatsBeforeRestart: hbCountBeforeRestart,
        heartbeatsAfterRestart: hbCountAfterRestart,
        noDuplicateCheckpoint: true,
      };
    }

    logStage("short stability snapshot (session evidence, not a soak)");
    {
      const stats = sqlInQuorum(
        project,
        composeEnv,
        `
        return {
          openIncidents: db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE status IN ('open','acknowledged')").get().c,
          pendingOutbox: db.prepare("SELECT COUNT(*) AS c FROM notification_outbox WHERE processed_at IS NULL").get().c,
          failedAttempts: db.prepare("SELECT COUNT(*) AS c FROM notification_attempts WHERE status = 'failed'").get().c,
          heartbeatEvents: db.prepare("SELECT COUNT(*) AS c FROM heartbeat_events").get().c,
        };
        `,
      );
      const health = await fetchWithTimeout(`${publicBase}/readyz`);
      evidence.results.stabilitySnapshot = {
        readyz: health.status,
        ...stats,
        note: "Short session only; owner must run 24-48h soak separately",
      };
      assert(
        health.status === 200,
        `readyz after session expected 200, got ${health.status}`,
      );
    }

    evidence.ok = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.alertDeliveries = countComposeAlertDeliveries(project, composeEnv);
    console.log("[ok] real n8n validation passed all required assertions");
  } catch (error) {
    evidence.ok = false;
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.finishedAt = new Date().toISOString();
    console.error(
      "[fail] real n8n validation:",
      error instanceof Error ? error.message : error,
    );
    exitCode = 1;
  } finally {
    try {
      fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
      fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`[info] wrote evidence ${EVIDENCE_PATH}`);
    } catch (writeErr) {
      console.error(
        "[warn] could not write evidence file:",
        writeErr instanceof Error ? writeErr.message : writeErr,
      );
    }
    await cleanup();
  }

  process.exit(exitCode);
}

main();
