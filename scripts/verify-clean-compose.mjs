#!/usr/bin/env node
/**
 * Clean-compose verification: archive/copy repo → compose up → setup/login/catalog → down -v.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchWithTimeout, waitForUrl } from "./lib/http.mjs";
import {
  isPortFree,
  findFreePort,
  logStage,
  randomToken,
  rmQuiet,
  setupAndLogin,
} from "./lib/quorum-verify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: false,
    ...options,
  });
  if (result.status !== 0) {
    const err = result.stderr || result.stdout || `exit ${result.status}`;
    throw new Error(`${cmd} ${args.join(" ")} failed: ${err}`);
  }
  return result;
}

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

function tryGitArchive(destDir) {
  const tarPath = path.join(os.tmpdir(), `quorum-archive-${process.pid}.tar`);
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    execFileSync("git", ["archive", "--format=tar", "-o", tarPath, "HEAD"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync("tar", ["-xf", tarPath, "-C", destDir], { stdio: "pipe" });
    return true;
  } catch (error) {
    console.warn(
      "[warn] git archive unavailable; using filtered copy:",
      error instanceof Error ? error.message.split("\n")[0] : error,
    );
    return false;
  } finally {
    rmQuiet(tarPath);
  }
}

const SKIP_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".turbo",
]);

function shouldSkip(name) {
  if (SKIP_NAMES.has(name)) return true;
  if (name.endsWith(".sqlite")) return true;
  if (name === ".env") return true;
  return false;
}

function filteredCopy(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldSkip(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      filteredCopy(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function compose(project, workDir, args, env) {
  return run(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.dev.yml",
      ...args,
    ],
    {
      cwd: workDir,
      env: { ...process.env, ...env },
      stdio: "inherit",
    },
  );
}

async function main() {
  const project = `quorum-clean-${Date.now().toString(36)}`;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-clean-"));
  const kek = `kek-${randomToken(24)}`;
  const setupToken = `setup-${randomToken(24)}`;
  let hostPort = 3000;
  let exited = false;

  const cleanup = () => {
    if (exited) return;
    exited = true;
    logStage("cleanup compose down -v");
    try {
      spawnSync(
        "docker",
        [
          "compose",
          "-p",
          project,
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.dev.yml",
          "down",
          "-v",
          "--remove-orphans",
        ],
        { cwd: workDir, stdio: "inherit", env: process.env },
      );
    } catch {
      // ignore
    }
    rmQuiet(workDir);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    assertDockerDaemon();

    logStage("materialize temp project");
    if (!tryGitArchive(workDir)) {
      filteredCopy(REPO_ROOT, workDir);
    }

    // Ensure ports mapping supports QUORUM_HOST_PORT (in case archive is stale).
    const composePath = path.join(workDir, "docker-compose.yml");
    let composeYaml = fs.readFileSync(composePath, "utf8");
    if (!composeYaml.includes("QUORUM_HOST_PORT")) {
      composeYaml = composeYaml.replace(
        /ports:\s*\n\s*-\s*"3000:3000"/,
        'ports:\n      - "${QUORUM_HOST_PORT:-3000}:3000"',
      );
      fs.writeFileSync(composePath, composeYaml);
    }

    if (!(await isPortFree(3000))) {
      hostPort = await findFreePort();
      console.log(`[info] port 3000 busy; using QUORUM_HOST_PORT=${hostPort}`);
    }

    const publicBase = `http://127.0.0.1:${hostPort}`;
    const envFile = [
      `QUORUM_CREDENTIAL_KEK=${kek}`,
      `QUORUM_SETUP_TOKEN=${setupToken}`,
      `QUORUM_UI_AUTH_ENABLED=true`,
      `PUBLIC_BASE_URL=${publicBase}`,
      `QUORUM_HOST_PORT=${hostPort}`,
    ].join("\n");
    fs.writeFileSync(path.join(workDir, ".env"), envFile);

    const composeEnv = {
      QUORUM_CREDENTIAL_KEK: kek,
      QUORUM_SETUP_TOKEN: setupToken,
      QUORUM_UI_AUTH_ENABLED: "true",
      PUBLIC_BASE_URL: publicBase,
      QUORUM_HOST_PORT: String(hostPort),
    };

    logStage("docker compose up --build -d");
    compose(project, workDir, ["up", "--build", "-d"], composeEnv);

    logStage("wait /readyz");
    await waitForUrl(`${publicBase}/readyz`, {
      okStatuses: [200],
      timeoutMs: 240_000,
      label: "/readyz",
    });

    logStage("wait /health/live");
    await waitForUrl(`${publicBase}/health/live`, {
      okStatuses: [200],
      timeoutMs: 60_000,
      label: "/health/live",
    });

    logStage("wait /health/watcher (may warm)");
    await waitForUrl(`${publicBase}/health/watcher`, {
      okStatuses: [200],
      timeoutMs: 180_000,
      label: "/health/watcher",
    });

    logStage("setup → login → catalog");
    await setupAndLogin(publicBase, { setupToken });

    logStage("recheck health endpoints");
    for (const pathName of ["/health/live", "/readyz", "/health/watcher"]) {
      const res = await fetchWithTimeout(`${publicBase}${pathName}`);
      if (res.status !== 200) {
        throw new Error(`${pathName} returned ${res.status}`);
      }
    }

    console.log("[ok] clean compose verification passed");
  } catch (error) {
    console.error(
      "[fail] clean compose:",
      error instanceof Error ? error.message : error,
    );
    cleanup();
    process.exitCode = 1;
    return;
  }

  cleanup();
}

main();
