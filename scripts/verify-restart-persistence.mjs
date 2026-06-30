#!/usr/bin/env node
/**
 * Process-based restart + persistence verification (same SQLite + KEK).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchWithTimeout, waitForUrl } from "./lib/http.mjs";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  findFreePort,
  listenHttpMock,
  logStage,
  mintCredential,
  postHeartbeat,
  protectPushContract,
  randomToken,
  rmQuiet,
  setupAndLogin,
  signHeartbeat,
  spawnQuorum,
  stopProcess,
} from "./lib/quorum-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

function ensureBuild() {
  const entry = path.join(REPO_ROOT, "dist", "main.js");
  if (fs.existsSync(entry)) return;
  logStage("npm run build");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error("build failed");
  }
}

function openSqlite(dbPath, { readonly = false } = {}) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, {
    readonly,
    fileMustExist: true,
  });
  db.pragma("busy_timeout = 5000");
  return db;
}

function countRows(db, sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return Number(Object.values(row)[0] ?? 0);
}

async function main() {
  ensureBuild();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-restart-"));
  const dbPath = path.join(tempDir, "quorum.sqlite");
  const kek = `kek-${randomToken(24)}`;
  const setupToken = `setup-${randomToken(24)}`;
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const alertHits = [];

  let mock = null;
  let proc = null;
  let exitCode = 0;

  const cleanup = async () => {
    if (proc?.child) await stopProcess(proc.child);
    if (mock) await mock.close();
    rmQuiet(tempDir);
  };

  process.on("SIGINT", () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    logStage("start alert mock");
    mock = await listenHttpMock((_req, res) => {
      alertHits.push(Date.now());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    const baseEnv = {
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: `file:${dbPath}`,
      QUORUM_EDITION: "self_hosted",
      QUORUM_TELEMETRY_ENABLED: "false",
      QUORUM_CREDENTIAL_KEK: kek,
      QUORUM_SETUP_TOKEN: setupToken,
      PUBLIC_BASE_URL: baseUrl,
      WATCHER_INTERVAL_MS: "2000",
      WATCHER_STALE_MS: "30000",
      OUTBOX_INTERVAL_MS: "2000",
      N8N_POLL_SCHEDULER_INTERVAL_MS: "5000",
    };

    logStage("spawn quorum (first boot)");
    proc = spawnQuorum(baseEnv, {
      entry: path.join(REPO_ROOT, "dist", "main.js"),
    });

    await waitForUrl(`${baseUrl}/readyz`, {
      timeoutMs: 90_000,
      label: "/readyz",
    });

    logStage("setup admin + protect flow");
    const session = await setupAndLogin(baseUrl, { setupToken });
    const protected_ = await protectPushContract(baseUrl, session, {
      webhookUrl: mock.url,
      acknowledgedNoAlertMode: "1",
      workflowName: "Restart Persistence Workflow",
      externalWorkflowId: "ext-restart-1",
    });

    logStage("mint credential");
    const cred = await mintCredential(
      baseUrl,
      session.cookie,
      protected_.csrf,
      protected_.workflowId,
    );

    logStage("hard-failure heartbeat → open incident");
    const failBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: new Date().toISOString(),
        status: "failure",
        itemsProcessed: 0,
        externalExecutionRef: `fail-${Date.now()}`,
      }),
    );
    const failSigned = signHeartbeat({
      secret: cred.secret,
      workflowId: protected_.workflowId,
      keyId: cred.keyId,
      body: failBody,
      idempotencyKey: `idem-fail-${Date.now()}`,
    });
    const failRes = await postHeartbeat(baseUrl, failSigned);
    if (failRes.status !== 202) {
      throw new Error(
        `hard-failure heartbeat expected 202, got ${failRes.status}: ${await failRes.text()}`,
      );
    }

    // Brief wait for ingest + incident write
    await new Promise((r) => setTimeout(r, 500));

    let db = openSqlite(dbPath, { readonly: true });
    const incidentsBefore = countRows(
      db,
      `SELECT COUNT(*) AS c FROM incidents WHERE status = 'open'`,
    );
    const heartbeatsBefore = countRows(
      db,
      `SELECT COUNT(*) AS c FROM heartbeat_events`,
    );
    const contractsBefore = countRows(
      db,
      `SELECT COUNT(*) AS c FROM workflow_contracts WHERE is_active = 1`,
    );
    db.close();

    if (incidentsBefore < 1) {
      throw new Error("expected at least one open incident after hard failure");
    }
    if (heartbeatsBefore < 1) {
      throw new Error("expected heartbeat_events row");
    }
    if (contractsBefore < 1) {
      throw new Error("expected active contract");
    }
    console.log(
      `[info] pre-restart: incidents=${incidentsBefore} heartbeats=${heartbeatsBefore} contracts=${contractsBefore}`,
    );

    logStage("SIGTERM first process");
    await stopProcess(proc.child, { signal: "SIGTERM", timeoutMs: 20_000 });
    proc = null;

    logStage("restart with same db + KEK");
    proc = spawnQuorum(baseEnv, {
      entry: path.join(REPO_ROOT, "dist", "main.js"),
    });
    await waitForUrl(`${baseUrl}/readyz`, {
      timeoutMs: 90_000,
      label: "/readyz after restart",
    });

    logStage("confirm admin login + persistence");
    const session2 = await setupAndLogin(baseUrl, {
      setupToken,
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    // setup already done — login path inside setupAndLogin handles existing admin

    db = openSqlite(dbPath, { readonly: true });
    const incidentsAfter = countRows(
      db,
      `SELECT COUNT(*) AS c FROM incidents WHERE status = 'open'`,
    );
    const heartbeatsAfter = countRows(
      db,
      `SELECT COUNT(*) AS c FROM heartbeat_events`,
    );
    const contractsAfter = countRows(
      db,
      `SELECT COUNT(*) AS c FROM workflow_contracts WHERE is_active = 1`,
    );
    db.close();

    if (incidentsAfter < 1 || heartbeatsAfter < 1 || contractsAfter < 1) {
      throw new Error(
        `persistence lost after restart (incidents=${incidentsAfter}, heartbeats=${heartbeatsAfter}, contracts=${contractsAfter})`,
      );
    }
    void session2;

    logStage("success heartbeat → resolve incident");
    const okBody = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        executedAt: new Date().toISOString(),
        status: "success",
        itemsProcessed: 2,
        externalExecutionRef: `ok-${Date.now()}`,
      }),
    );
    const okSigned = signHeartbeat({
      secret: cred.secret,
      workflowId: protected_.workflowId,
      keyId: cred.keyId,
      body: okBody,
      idempotencyKey: `idem-ok-${Date.now()}`,
    });
    const okRes = await postHeartbeat(baseUrl, okSigned);
    if (okRes.status !== 202) {
      throw new Error(
        `success heartbeat expected 202, got ${okRes.status}: ${await okRes.text()}`,
      );
    }

    await new Promise((r) => setTimeout(r, 800));
    db = openSqlite(dbPath, { readonly: true });
    const openAfterResolve = countRows(
      db,
      `SELECT COUNT(*) AS c FROM incidents WHERE status IN ('open', 'acknowledged')`,
    );
    const resolved = countRows(
      db,
      `SELECT COUNT(*) AS c FROM incidents WHERE status = 'resolved'`,
    );
    db.close();
    if (openAfterResolve > 0 || resolved < 1) {
      throw new Error(
        `expected hard_failure incident to resolve (open=${openAfterResolve}, resolved=${resolved})`,
      );
    }
    console.log(
      `[info] after success: open=${openAfterResolve} resolved=${resolved}`,
    );

    logStage("stop process before wrong-KEK restart");
    await stopProcess(proc.child);
    proc = null;

    logStage("wrong KEK restart (expect decrypt failure, never print KEK)");
    const wrongKek = `wrong-${randomToken(24)}`;
    const wrongEnv = { ...baseEnv, QUORUM_CREDENTIAL_KEK: wrongKek };
    proc = spawnQuorum(wrongEnv, {
      entry: path.join(REPO_ROOT, "dist", "main.js"),
    });

    // Process may still listen; wait for ready or exit.
    let ready = false;
    try {
      await waitForUrl(`${baseUrl}/readyz`, {
        timeoutMs: 45_000,
        label: "/readyz wrong KEK",
      });
      ready = true;
    } catch {
      // process may have exited — also acceptable as "clear failure"
    }

    const output = proc.getOutput();
    if (output.includes(kek) || output.includes(wrongKek)) {
      throw new Error(
        "KEK value appeared in process output (must never print)",
      );
    }

    if (ready) {
      // Heartbeat with original secret material cannot be verified if KEK wrong
      // (credential decrypt fails → unauthorized).
      const probe = signHeartbeat({
        secret: cred.secret,
        workflowId: protected_.workflowId,
        keyId: cred.keyId,
        body: okBody,
        idempotencyKey: `idem-wrongkek-${Date.now()}`,
      });
      const probeRes = await postHeartbeat(baseUrl, probe);
      if (probeRes.status === 202) {
        throw new Error(
          "heartbeat unexpectedly accepted under wrong KEK (decrypt should fail)",
        );
      }
      console.log(
        `[info] wrong KEK: heartbeat rejected with ${probeRes.status} (expected)`,
      );

      // Alert channel decrypt / ops should not echo KEK
      const health = await fetchWithTimeout(`${baseUrl}/health/live`);
      const healthText = await health.text();
      if (healthText.includes(kek) || healthText.includes(wrongKek)) {
        throw new Error("KEK leaked via /health/live");
      }
    } else {
      console.log("[info] wrong KEK: process did not stay ready (acceptable)");
    }

    console.log("[ok] restart persistence verification passed");
  } catch (error) {
    console.error(
      "[fail] restart persistence:",
      error instanceof Error ? error.message : error,
    );
    if (proc) {
      console.error("--- process stderr (tail) ---");
      console.error(proc.getStderr().slice(-4000));
    }
    exitCode = 1;
  } finally {
    await cleanup();
  }

  process.exit(exitCode);
}

main();
