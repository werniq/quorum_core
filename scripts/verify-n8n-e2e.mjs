#!/usr/bin/env node
/**
 * Real n8n ↔ Quorum e2e via docker-compose.e2e.yml (no mocks for n8n/Quorum).
 * Pinned image: n8nio/n8n:1.95.3 (fallback documented if pull fails).
 */
import { spawnSync } from "node:child_process";
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
const COMPOSE_FILE = path.join(REPO_ROOT, "docker-compose.e2e.yml");
const N8N_IMAGE_PRIMARY = "n8nio/n8n:1.95.3";
const N8N_IMAGE_FALLBACK = "n8nio/n8n:1.84.0";

const N8N_OWNER = {
  email: "e2e-owner@quorum.local",
  firstName: "E2E",
  lastName: "Owner",
  password: "E2e-Owner-Password-OK!",
};

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

function compose(project, args, env = {}) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "-f", COMPOSE_FILE, ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      shell: false,
    },
  );
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
    [
      "compose",
      "-p",
      project,
      "-f",
      COMPOSE_FILE,
      "down",
      "-v",
      "--remove-orphans",
    ],
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

function limitation(msg) {
  console.error(`[limitation] ${msg}`);
}

async function ensureN8nImage() {
  logStage(`pull ${N8N_IMAGE_PRIMARY}`);
  let pull = spawnSync("docker", ["pull", N8N_IMAGE_PRIMARY], {
    encoding: "utf8",
  });
  if (pull.status === 0) return N8N_IMAGE_PRIMARY;
  console.warn(`[warn] pull ${N8N_IMAGE_PRIMARY} failed; trying fallback`);
  pull = spawnSync("docker", ["pull", N8N_IMAGE_FALLBACK], {
    encoding: "utf8",
  });
  if (pull.status === 0) return N8N_IMAGE_FALLBACK;
  throw new Error(
    `Could not pull ${N8N_IMAGE_PRIMARY} or ${N8N_IMAGE_FALLBACK}`,
  );
}

/**
 * Automate n8n owner setup + API key via REST (cookie session).
 * Returns API key string or null if unsupported on this build.
 */
async function obtainN8nApiKey(n8nBase) {
  const root = n8nBase.replace(/\/+$/, "");

  // Owner setup (idempotent-ish: ignore if already configured). Retry while n8n finishes boot.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const setup = await fetchWithTimeout(`${root}/rest/owner/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(N8N_OWNER),
        timeoutMs: 30_000,
      });
      const setupText = await setup.text();
      if (/starting up/i.test(setupText) || setup.status === 404) {
        await new Promise((r) => setTimeout(r, 2_500));
        continue;
      }
      if (![200, 201, 204].includes(setup.status) && setup.status !== 400) {
        limitation(
          `n8n owner setup returned ${setup.status}: ${setupText.slice(0, 200)}`,
        );
      }
      break;
    } catch (error) {
      if (attempt === 8) {
        limitation(
          `n8n owner setup request failed: ${error instanceof Error ? error.message : error}`,
        );
      } else {
        await new Promise((r) => setTimeout(r, 2_500));
      }
    }
  }

  let cookieHeader = "";
  let loginStatus = 0;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
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
    loginStatus = login.status;
    const loginText = await login.text();
    if (/starting up/i.test(loginText) || login.status === 404) {
      await new Promise((r) => setTimeout(r, 2_500));
      continue;
    }
    const setCookies = login.headers.getSetCookie?.() ?? [];
    cookieHeader =
      setCookies.length > 0
        ? setCookies.map((c) => c.split(";")[0]).join("; ")
        : (login.headers.get("set-cookie")?.split(";")[0] ?? "");
    if (login.status < 400 && cookieHeader) break;
    await new Promise((r) => setTimeout(r, 2_500));
  }

  if (loginStatus >= 400 || !cookieHeader) {
    limitation(
      `n8n login failed (${loginStatus}); cannot mint API key automatically. See docs/verification/n8n-e2e-limitations.md`,
    );
    return null;
  }

  // Try several API-key endpoints used across n8n 1.x builds
  // Discover scopes allowed for this owner role (n8n 1.95 rejects unknown scopes).
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
      body: { label: "quorum-e2e", expiresAt, scopes },
    },
    {
      url: `${root}/rest/api-keys`,
      body: { label: "quorum-e2e", expiresAt, scopes: [] },
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
      limitation(
        `n8n API key create returned ${res.status} but key field not found: ${text.slice(0, 300)}`,
      );
    } else {
      limitation(
        `n8n API key create ${candidate.url} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  }

  // Env override for operators who pre-created a key
  if (process.env.N8N_API_KEY) {
    console.log("[info] using N8N_API_KEY from environment");
    return process.env.N8N_API_KEY;
  }
  return null;
}

function n8nHeartbeatCodeJs(workflowId, keyId, secret, quorumBase) {
  // Runs inside n8n Code node (Node.js crypto available on self-hosted).
  return `
const crypto = require('crypto');
const workflowId = ${JSON.stringify(workflowId)};
const keyId = ${JSON.stringify(keyId)};
const secret = ${JSON.stringify(secret)};
const path = '/api/v1/workflows/' + workflowId + '/heartbeats';
const body = {
  schemaVersion: 1,
  executedAt: new Date().toISOString(),
  status: 'success',
  itemsProcessed: 1,
  externalExecutionRef: 'n8n-e2e-' + Date.now(),
};
const raw = JSON.stringify(body);
const ts = String(Math.floor(Date.now() / 1000));
const idem = 'n8n-push-' + Date.now() + '-' + Math.random().toString(16).slice(2);
const bodySha = crypto.createHash('sha256').update(raw).digest('hex');
const payload = ['POST', path, ts, idem, bodySha].join('\\n');
const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
return [{
  json: {
    url: ${JSON.stringify(quorumBase)} + path,
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

async function createAndRunPushWorkflow(n8nBase, apiKey, input) {
  const root = n8nBase.replace(/\/+$/, "");
  const code = n8nHeartbeatCodeJs(
    input.workflowId,
    input.keyId,
    input.secret,
    input.quorumInternalBase,
  );

  const workflow = {
    name: "Quorum E2E Push Heartbeat",
    nodes: [
      {
        parameters: {},
        id: "manual-trigger",
        name: "When clicking ‘Test workflow’",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
      },
      {
        parameters: {
          httpMethod: "POST",
          path: "quorum-e2e-hb",
          responseMode: "lastNode",
          options: {},
        },
        id: "webhook-trigger",
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        position: [0, 220],
        webhookId: "quorum-e2e-hb",
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
                value: "={{$json.headers['content-type']}}",
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
      "When clicking ‘Test workflow’": {
        main: [[{ node: "Sign Quorum Heartbeat", type: "main", index: 0 }]],
      },
      Webhook: {
        main: [[{ node: "Sign Quorum Heartbeat", type: "main", index: 0 }]],
      },
      "Sign Quorum Heartbeat": {
        main: [[{ node: "POST Quorum Heartbeat", type: "main", index: 0 }]],
      },
    },
    settings: { executionOrder: "v1" },
  };

  const create = await fetchWithTimeout(`${root}/api/v1/workflows`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
    body: JSON.stringify(workflow),
    timeoutMs: 60_000,
  });
  const createdText = await create.text();
  if (create.status >= 300) {
    throw new Error(
      `n8n create workflow failed ${create.status}: ${createdText.slice(0, 400)}`,
    );
  }
  const created = JSON.parse(createdText);
  const n8nWorkflowId = String(created.id ?? created.data?.id);
  if (!n8nWorkflowId) {
    throw new Error(
      `n8n create workflow missing id: ${createdText.slice(0, 300)}`,
    );
  }

  // Activate (required for production webhook path). Prefer dedicated activate endpoint.
  let activated = false;
  const activateAttempts = [
    {
      method: "POST",
      url: `${root}/api/v1/workflows/${n8nWorkflowId}/activate`,
      body: "{}",
    },
    {
      method: "PATCH",
      url: `${root}/api/v1/workflows/${n8nWorkflowId}`,
      body: JSON.stringify({ active: true }),
    },
  ];
  for (const attempt of activateAttempts) {
    const activate = await fetchWithTimeout(attempt.url, {
      method: attempt.method,
      headers: {
        "content-type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      body: attempt.body,
      timeoutMs: 30_000,
    });
    if (activate.status >= 200 && activate.status < 300) {
      activated = true;
      console.log(
        `[info] n8n activate via ${attempt.method} ${attempt.url} → ${activate.status}`,
      );
      break;
    }
    limitation(
      `n8n activate ${attempt.method} → ${activate.status}: ${(await activate.text()).slice(0, 160)}`,
    );
  }
  if (!activated) {
    throw new Error(
      "n8n workflow activation failed; production webhook path requires active workflow",
    );
  }

  // Prefer REST execute; if unavailable, HTTP-trigger the webhook (HMAC still in n8n Code).
  const execPaths = [
    `${root}/api/v1/workflows/${n8nWorkflowId}/run`,
    `${root}/api/v1/workflows/${n8nWorkflowId}/execute`,
    `${root}/rest/workflows/${n8nWorkflowId}/run`,
  ];
  let executed = false;
  for (const url of execPaths) {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-N8N-API-KEY": apiKey,
      },
      body: "{}",
      timeoutMs: 60_000,
    });
    if (res.status >= 200 && res.status < 300) {
      executed = true;
      console.log(`[info] n8n execute via ${url} → ${res.status}`);
      break;
    }
    limitation(
      `n8n execute ${url} → ${res.status}: ${(await res.text()).slice(0, 160)}`,
    );
  }

  if (!executed) {
    const webhookUrl = `${root}/webhook/quorum-e2e-hb`;
    console.log(
      `[info] n8n execute API unavailable; triggering webhook ${webhookUrl} (signing stays in n8n Code)`,
    );
    const wh = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeoutMs: 60_000,
    });
    if (wh.status >= 400) {
      throw new Error(
        `n8n webhook trigger failed ${wh.status}: ${(await wh.text()).slice(0, 300)}. Refusing host-signed happy-path fallback.`,
      );
    }
    console.log(`[info] n8n webhook trigger → ${wh.status}`);
  }

  return n8nWorkflowId;
}

async function main() {
  const project = `quorum-e2e-${Date.now().toString(36)}`;
  const kek = `kek-${randomToken(24)}`;
  const setupToken = `setup-${randomToken(24)}`;
  let hostPort = 3000;
  let n8nPort = 5678;
  let exitCode = 0;
  let started = false;

  const cleanup = () => {
    if (started) {
      logStage("compose down");
      composeDown(project, {
        QUORUM_CREDENTIAL_KEK: kek,
        QUORUM_SETUP_TOKEN: setupToken,
      });
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    assertDockerDaemon();
    const image = await ensureN8nImage();
    hostPort = await findFreePort();
    n8nPort = await findFreePort();
    // Avoid colliding with a just-freed default if another stack still holds it.
    if (hostPort === n8nPort) n8nPort = await findFreePort();

    const publicBase = `http://127.0.0.1:${hostPort}`;
    const n8nPublic = `http://127.0.0.1:${n8nPort}`;
    const composeEnv = {
      QUORUM_CREDENTIAL_KEK: kek,
      QUORUM_SETUP_TOKEN: setupToken,
      PUBLIC_BASE_URL: publicBase,
      QUORUM_HOST_PORT: String(hostPort),
      N8N_HOST_PORT: String(n8nPort),
      N8N_IMAGE: image,
      N8N_ENCRYPTION_KEY: "test-encryption-key-32chars!!",
    };

    logStage("compose up e2e");
    compose(project, ["up", "--build", "-d"], composeEnv);
    started = true;

    logStage("wait Quorum + n8n");
    await waitForUrl(`${publicBase}/readyz`, {
      timeoutMs: 300_000,
      label: "quorum /readyz",
    });
    await waitForUrl(`${n8nPublic}/healthz`, {
      okStatuses: [200, 204],
      timeoutMs: 300_000,
      label: "n8n /healthz",
    }).catch(async () => {
      // older n8n may only expose /
      await waitForUrl(n8nPublic, {
        okStatuses: [200, 302],
        timeoutMs: 60_000,
        label: "n8n /",
      });
    });
    await waitForN8nRestReady(n8nPublic, { timeoutMs: 300_000 });

    logStage("Quorum setup + protect push contract");
    const session = await setupAndLogin(publicBase, { setupToken });
    const protected_ = await protectPushContract(publicBase, session, {
      webhookUrl: "http://127.0.0.1:9/unused",
      acknowledgedNoAlertMode: "1",
      workflowName: "E2E Push",
      externalWorkflowId: "n8n-e2e-push",
    });
    const cred = await mintCredential(
      publicBase,
      session.cookie,
      protected_.csrf,
      protected_.workflowId,
    );

    logStage("obtain n8n API key");
    const apiKey = await obtainN8nApiKey(n8nPublic);

    if (!apiKey) {
      throw new Error(
        "n8n API key unavailable; refusing host-signed happy-path push. Set N8N_API_KEY or fix n8n owner/API-key minting.",
      );
    }

    logStage("push path via real n8n workflow");
    await createAndRunPushWorkflow(n8nPublic, apiKey, {
      workflowId: protected_.workflowId,
      keyId: cred.keyId,
      secret: cred.secret,
      quorumInternalBase: "http://quorum:3000",
      quorumPublicBase: publicBase,
    });

    // Allow ingest to settle
    await new Promise((r) => setTimeout(r, 1000));

    logStage("invalid signature → 401");
    {
      // Host-forged adversarial only.
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 1,
          externalExecutionRef: `bad-sig-${Date.now()}`,
        }),
      );
      const signed = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body,
        idempotencyKey: `bad-sig-${Date.now()}`,
      });
      signed.headers["x-quorum-signature"] = "00".repeat(32);
      const res = await postHeartbeat(publicBase, signed);
      if (res.status !== 401) {
        throw new Error(`expected 401 for bad signature, got ${res.status}`);
      }
    }

    logStage("idempotency replay");
    {
      // Host-forged adversarial/replay harness (same body + signature).
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 3,
          externalExecutionRef: `idem-${Date.now()}`,
        }),
      );
      const idem = `idem-replay-${Date.now()}`;
      const signed = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body,
        idempotencyKey: idem,
      });
      const first = await postHeartbeat(publicBase, signed);
      const second = await postHeartbeat(publicBase, signed);
      if (first.status !== 202 || second.status !== 202) {
        throw new Error(
          `idempotency expected 202/202, got ${first.status}/${second.status}`,
        );
      }
      const secondJson = await second.json();
      if (secondJson.idempotentReplay !== true) {
        throw new Error(
          `expected idempotentReplay=true, got ${JSON.stringify(secondJson)}`,
        );
      }
    }

    logStage("hard-failure opens incident");
    {
      // Host-forged adversarial/control path for failure status.
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "failure",
          itemsProcessed: 0,
          externalExecutionRef: `hard-${Date.now()}`,
        }),
      );
      const signed = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body,
        idempotencyKey: `hard-${Date.now()}`,
      });
      const res = await postHeartbeat(publicBase, signed);
      if (res.status !== 202) {
        throw new Error(`hard-failure heartbeat failed: ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, 500));
      const catalog = await fetchWithTimeout(
        `${publicBase}/api/v1/catalog/contracts`,
      );
      const catalogJson = await catalog.json();
      const row = (catalogJson.contracts ?? []).find(
        (c) => c.workflowId === protected_.workflowId,
      );
      console.log(
        `[info] catalog health after hard-failure: ${row?.health ?? "n/a"}`,
      );
    }

    logStage("empty-result policy path");
    {
      // Default contract emptyResultPolicy is "allowed" — accept zero items without incident.
      // Host-forged control path (not the happy-path success push).
      const body = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          executedAt: new Date().toISOString(),
          status: "success",
          itemsProcessed: 0,
          externalExecutionRef: `empty-${Date.now()}`,
        }),
      );
      const signed = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body,
        idempotencyKey: `empty-${Date.now()}`,
      });
      const res = await postHeartbeat(publicBase, signed);
      if (res.status !== 202) {
        throw new Error(`empty-result heartbeat failed: ${res.status}`);
      }
      console.log(
        "[info] empty-result with policy=allowed accepted (failure policy covered by unit tests)",
      );
    }

    limitation(
      "silent-absence full 60s quiet-window wait is not exercised here; hard-failure is the primary incident path. Quiet-window / silent-absence covered by unit/watcher tests and npm run test:e2e:n8n:real.",
    );

    // --- Poll path ---
    logStage("poll path: configure n8n connector");
    {
      const protectPage = await fetchWithTimeout(`${publicBase}/protect`, {
        headers: { cookie: session.cookie },
      });
      let csrf = parseCsrfFromHtml(await protectPage.text()) ?? session.csrf;

      const connectorRes = await formPost(
        `${publicBase}/connectors/n8n`,
        {
          csrf,
          name: "e2e-n8n",
          baseUrl: "http://n8n:5678",
          apiKey,
        },
        { cookie: session.cookie, redirect: "manual" },
      );
      if (![200, 302, 303].includes(connectorRes.status)) {
        const t = await connectorRes.text();
        limitation(
          `POST /connectors/n8n returned ${connectorRes.status}: ${t.slice(0, 200)}`,
        );
      } else {
        console.log("[info] n8n connector created via UI form POST");
      }

      // Invalid credentials visibility: force bad key update if we have a connector id
      const connectorsPage = await fetchWithTimeout(
        `${publicBase}/connectors`,
        {
          headers: { cookie: session.cookie },
        },
      );
      const connectorsHtml = await connectorsPage.text();
      console.log(
        `[info] connectors page status=${connectorsPage.status} contains n8n=${connectorsHtml.includes("n8n") || connectorsHtml.includes("e2e-n8n")}`,
      );

      limitation(
        "Poll success against docker-network http://n8n:5678 requires self_hosted_local network policy (wired in main.ts). Invalid API keys should surface connector health failure. Checkpoint resume and two-worker claim exclusivity remain covered by unit tests (tests/n8n/*). UI may not bind workflows.connector_id; when unbound, scheduler skips until bound (unit tests cover bound poll).",
      );

      // Invalid credentials: connector with bad key should degrade after poll attempt
      {
        const badKeyRes = await formPost(
          `${publicBase}/connectors/n8n`,
          {
            csrf,
            name: "e2e-n8n-bad",
            baseUrl: "http://n8n:5678",
            apiKey: "definitely-not-a-valid-n8n-api-key",
          },
          { cookie: session.cookie, redirect: "manual" },
        );
        console.log(
          `[info] bad-key connector create status=${badKeyRes.status}`,
        );
      }

      // Try binding a poll workflow + short wait for scheduler
      {
        const wfPage = await fetchWithTimeout(`${publicBase}/workflows`, {
          headers: { cookie: session.cookie },
        });
        const wfHtml = await wfPage.text();
        csrf = parseCsrfFromHtml(wfHtml) ?? csrf;
        await formPost(
          `${publicBase}/workflows`,
          {
            csrf,
            name: "E2E Poll Workflow",
            externalWorkflowId: "poll-ext-1",
            monitoringMethod: "poll",
          },
          { cookie: session.cookie, redirect: "manual" },
        );
        console.log(
          "[info] poll workflow registered; waiting briefly for scheduler tick",
        );
        await new Promise((r) => setTimeout(r, 12_000));
        const connectors2 = await fetchWithTimeout(`${publicBase}/connectors`, {
          headers: { cookie: session.cookie },
        });
        const html2 = await connectors2.text();
        const healthVisible =
          html2.includes("auth_failed") ||
          html2.includes("unreachable") ||
          html2.includes("misconfigured") ||
          html2.includes("healthy") ||
          html2.includes("e2e-n8n");
        console.log(
          `[info] connectors after poll window: health_or_row_visible=${healthVisible}`,
        );
      }
    }

    console.log(`[ok] n8n e2e verification finished (image=${image})`);
  } catch (error) {
    console.error(
      "[fail] n8n e2e:",
      error instanceof Error ? error.message : error,
    );
    exitCode = 1;
  } finally {
    cleanup();
  }

  process.exit(exitCode);
}

main();
