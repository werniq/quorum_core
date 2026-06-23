import { pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import { buildApp } from "./app.js";

/**
 * HTTP process entry. Schema readiness must be supplied by the composition root
 * once migrators are wired (later milestones). Bootstrap only exposes healthz/readyz.
 */
export async function startServer(options?: {
  getSchemaReadiness?: Parameters<typeof buildApp>[0]["getSchemaReadiness"];
}): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({
    env,
    getSchemaReadiness:
      options?.getSchemaReadiness ??
      (() => ({
        status: "pending_migrations",
        pendingMigrations: ["connect-migrator"],
        appliedMigrations: [],
      })),
  });

  await app.listen({ host: env.HOST, port: env.PORT });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
