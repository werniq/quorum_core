import { defineConfig } from "vitest/config";

/**
 * Release gate: ≥90% branch coverage on cadence, incident lifecycle,
 * and evidence-level policy modules (task 16 blockers).
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: [
        "src/domain/cadence/**/*.ts",
        "src/domain/incidents/**/*.ts",
        "src/domain/reliability/**/*.ts",
        "src/domain/evidence/resolve-evidence-level.ts",
        "src/domain/evidence/unverified-dimensions.ts",
        "src/domain/evidence/empty-result.ts",
        "src/domain/catalog/evidence-explanation.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 90,
      },
    },
  },
});
