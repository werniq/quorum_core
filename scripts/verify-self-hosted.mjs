#!/usr/bin/env node
/**
 * Full self-hosted verification orchestrator (fail-fast).
 * Stages: format:check → lint → typecheck → tests → build → compose → restart → n8n e2e
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const STAGES = [
  { name: "format:check", npm: "format:check" },
  { name: "lint", npm: "lint" },
  { name: "typecheck", npm: "typecheck" },
  { name: "test", npm: "test" },
  { name: "test:integration", npm: "test:integration" },
  { name: "test:repository", npm: "test:repository" },
  { name: "test:migrations", npm: "test:migrations" },
  { name: "test:security", npm: "test:security" },
  { name: "test:cov", npm: "test:cov" },
  { name: "build", npm: "build" },
  { name: "test:compose", npm: "test:compose" },
  { name: "test:restart", npm: "test:restart" },
  { name: "test:e2e:n8n", npm: "test:e2e:n8n" },
];

function runNpm(script) {
  console.log(`[stage] ${script}`);
  const result = spawnSync("npm", ["run", script], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  return result.status ?? 1;
}

function main() {
  for (const stage of STAGES) {
    const code = runNpm(stage.npm);
    if (code !== 0) {
      console.error(`[fail] stage ${stage.name} exited ${code}`);
      // Docker stages clean up themselves; nothing extra required here.
      process.exit(code);
    }
  }
  console.log("[ok] verify:self-hosted passed all stages");
}

main();
