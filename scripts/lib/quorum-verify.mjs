/**
 * Shared Quorum verification helpers (HMAC, ports, UI session flows).
 */
import { createHmac, createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  extractCookie,
  fetchWithTimeout,
  formPost,
  parseCsrfFromHtml,
  waitForUrl,
} from "./http.mjs";

export const ADMIN_USER = "admin";
export const ADMIN_PASSWORD = "verify-local-password-ok";

export function logStage(name) {
  console.log(`[stage] ${name}`);
}

export function sha256Hex(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildHeartbeatSigningPayload(input) {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestampSeconds,
    input.idempotencyKey,
    input.bodySha256Hex,
  ].join("\n");
}

export function signHeartbeatHmacSha256(secret, signingPayload) {
  return createHmac("sha256", secret).update(signingPayload).digest("hex");
}

export function signHeartbeat({
  secret,
  workflowId,
  keyId,
  body,
  idempotencyKey,
  timestampSeconds = String(Math.floor(Date.now() / 1000)),
}) {
  const pathName = `/api/v1/workflows/${workflowId}/heartbeats`;
  const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const signature = signHeartbeatHmacSha256(
    secret,
    buildHeartbeatSigningPayload({
      method: "POST",
      path: pathName,
      timestampSeconds,
      idempotencyKey,
      bodySha256Hex: sha256Hex(rawBody),
    }),
  );
  return {
    path: pathName,
    timestampSeconds,
    idempotencyKey,
    keyId,
    signature,
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-quorum-key-id": keyId,
      "x-quorum-timestamp": timestampSeconds,
      "x-quorum-idempotency-key": idempotencyKey,
      "x-quorum-signature": signature,
    },
  };
}

export function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export function cookieHeader(sessionValue) {
  if (!sessionValue) return null;
  return sessionValue.includes("=")
    ? sessionValue
    : `quorum_session=${sessionValue}`;
}

/**
 * @param {string} baseUrl
 * @param {{ setupToken: string; username?: string; password?: string }} input
 */
export async function setupAndLogin(baseUrl, input) {
  const username = input.username ?? ADMIN_USER;
  const password = input.password ?? ADMIN_PASSWORD;
  const root = baseUrl.replace(/\/+$/, "");

  await waitForUrl(`${root}/readyz`, {
    okStatuses: [200],
    timeoutMs: 180_000,
    label: "/readyz",
  });

  const setupGet = await fetchWithTimeout(`${root}/setup`, {
    redirect: "manual",
  });
  if (setupGet.status === 200) {
    const setupPost = await formPost(`${root}/setup`, {
      setupToken: input.setupToken,
      username,
      password,
    });
    if (setupPost.status !== 302 && setupPost.status !== 303) {
      const text = await setupPost.text();
      throw new Error(
        `setup POST expected redirect, got ${setupPost.status}: ${text.slice(0, 200)}`,
      );
    }
  }

  const login = await formPost(`${root}/login`, { username, password });
  if (login.status !== 302 && login.status !== 303) {
    const text = await login.text();
    throw new Error(
      `login expected redirect, got ${login.status}: ${text.slice(0, 200)}`,
    );
  }
  const setCookies = login.headers.getSetCookie?.() ?? [];
  let session = null;
  for (const c of setCookies) {
    session = extractCookie(c);
    if (session) break;
  }
  if (!session) {
    session = extractCookie(login.headers.get("set-cookie"));
  }
  if (!session) {
    throw new Error("login did not set quorum_session cookie");
  }
  const cookie = cookieHeader(session);

  // Catalog is reachable even if onboarding is incomplete.
  const catalog = await fetchWithTimeout(`${root}/catalog`, {
    headers: { cookie },
    redirect: "manual",
  });
  const catalogHtml = await catalog.text();
  if (catalog.status !== 200) {
    throw new Error(`GET /catalog returned ${catalog.status}`);
  }
  if (!catalogHtml.includes("Contract Catalog")) {
    throw new Error("GET /catalog missing 'Contract Catalog'");
  }

  const protect = await fetchWithTimeout(`${root}/protect`, {
    headers: { cookie },
  });
  const protectHtml = await protect.text();
  const csrf = parseCsrfFromHtml(protectHtml) ?? parseCsrfFromHtml(catalogHtml);
  if (!csrf) {
    throw new Error("could not parse CSRF token after login");
  }

  return { cookie, csrf, username, password };
}

/**
 * Create client → workflow → contract → alert → activate via /protect/* forms.
 * @returns {Promise<{ clientId: string; workflowId: string; contractId: string; channelId: string; csrf: string }>}
 */
export async function protectPushContract(baseUrl, session, options = {}) {
  const root = baseUrl.replace(/\/+$/, "");
  const cookie = session.cookie;
  let csrf = session.csrf;
  const mockWebhookUrl =
    options.webhookUrl ?? "http://127.0.0.1:9/quorum-verify-unused";

  async function post(pathName, fields) {
    const response = await formPost(
      `${root}${pathName}`,
      { csrf, ...fields },
      { cookie, redirect: "manual" },
    );
    // Follow redirects that return HTML with next csrf, or read body on 200
    let html = "";
    let status = response.status;
    if (status === 302 || status === 303) {
      const location = response.headers.get("location");
      if (location) {
        const next = await fetchWithTimeout(
          location.startsWith("http") ? location : `${root}${location}`,
          { headers: { cookie } },
        );
        html = await next.text();
        status = next.status;
      }
    } else {
      html = await response.text();
    }
    const nextCsrf = parseCsrfFromHtml(html);
    if (nextCsrf) csrf = nextCsrf;
    return { status, html, response };
  }

  function extractHidden(html, name) {
    const re = new RegExp(
      `<input[^>]*name=["']${name}["'][^>]*value=["']([^"']*)["']`,
      "i",
    );
    const alt = new RegExp(
      `<input[^>]*value=["']([^"']*)["'][^>]*name=["']${name}["']`,
      "i",
    );
    return html.match(re)?.[1] ?? html.match(alt)?.[1] ?? "";
  }

  let r = await post("/protect/client", {
    newClientName: options.clientName ?? "Verify Client",
  });
  const clientId = extractHidden(r.html, "clientId");
  if (!clientId) throw new Error("protect/client missing clientId");

  r = await post("/protect/process", {
    clientId,
    templateId: "custom",
    businessPurpose: options.businessPurpose ?? "Verification contract",
  });

  r = await post("/protect/workflow", {
    clientId,
    templateId: "custom",
    businessPurpose: options.businessPurpose ?? "Verification contract",
    workflowName: options.workflowName ?? "Verify Workflow",
    externalWorkflowId: options.externalWorkflowId ?? "ext-verify-1",
    monitoringMethod: options.monitoringMethod ?? "push",
    cadenceValue: options.cadenceValue ?? "15",
  });
  const workflowId = extractHidden(r.html, "workflowId");
  if (!workflowId) throw new Error("protect/workflow missing workflowId");

  r = await post("/protect/contract", {
    clientId,
    workflowId,
    businessPurpose: options.businessPurpose ?? "Verification contract",
    name: options.contractName ?? "Verify Contract",
    cadenceType: options.cadenceType ?? "interval",
    cadenceValue: options.cadenceValue ?? "15",
    timezone: "UTC",
    explicitlyConfirmed: "1",
    evidenceAcknowledged: "1",
  });
  const contractId = extractHidden(r.html, "contractId");
  if (!contractId) throw new Error("protect/contract missing contractId");

  r = await post("/protect/alerts", {
    clientId,
    workflowId,
    contractId,
    channelName: options.channelName ?? "Verify webhook",
    url: mockWebhookUrl,
  });
  const channelId = extractHidden(r.html, "channelId");

  r = await post("/protect/activate", {
    clientId,
    workflowId,
    contractId,
    channelId: channelId || "",
    explicitlyConfirmed: "1",
    // Channel test may fail against mock; allow local no-alert mode as fallback.
    acknowledgedNoAlertMode: options.acknowledgedNoAlertMode ?? "1",
  });

  return { clientId, workflowId, contractId, channelId, csrf };
}

/**
 * Mint push credential; returns { keyId, secret }.
 */
export async function mintCredential(baseUrl, cookie, csrf, workflowId) {
  const root = baseUrl.replace(/\/+$/, "");
  const response = await formPost(
    `${root}/workflows/${workflowId}/credentials`,
    { csrf },
    { cookie, redirect: "manual" },
  );
  const html = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `credential mint failed: ${response.status} ${html.slice(0, 300)}`,
    );
  }
  const keyId = html.match(/Key id:\s*<code>([^<]+)<\/code>/i)?.[1];
  const secret = html.match(/Secret:\s*<code>([^<]+)<\/code>/i)?.[1];
  if (!keyId || !secret) {
    throw new Error("could not parse keyId/secret from credential page");
  }
  const nextCsrf = parseCsrfFromHtml(html);
  return { keyId, secret, csrf: nextCsrf ?? csrf, html };
}

export async function postHeartbeat(baseUrl, signed) {
  const root = baseUrl.replace(/\/+$/, "");
  return fetchWithTimeout(`${root}${signed.path}`, {
    method: "POST",
    headers: signed.headers,
    body: signed.rawBody,
    timeoutMs: 30_000,
  });
}

/**
 * Minimal HTTP mock using node:http.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void} onRequest
 */
export async function listenHttpMock(onRequest) {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      onRequest(req, res, body);
    });
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}/alert`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
    server,
  };
}

export function spawnQuorum(env, options = {}) {
  const nodeBin = process.execPath;
  const entry = options.entry ?? path.resolve("dist/main.js");
  const child = spawn(nodeBin, [entry], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
    if (options.pipeLogs) process.stdout.write(d);
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
    if (options.pipeLogs) process.stderr.write(d);
  });
  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    getOutput: () => stdout + stderr,
  };
}

export async function stopProcess(
  child,
  { signal = "SIGTERM", timeoutMs = 15_000 } = {},
) {
  if (!child || child.exitCode != null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill(signal);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}
