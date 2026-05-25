export type SchemaDialect = "sqlite" | "postgres";

export type SchemaReadinessState =
  | { status: "ready"; appliedMigrations: string[] }
  | {
      status: "pending_migrations";
      pendingMigrations: string[];
      appliedMigrations: string[];
    }
  | {
      status: "failed_migration";
      error: string;
      appliedMigrations: string[];
    };

export class SchemaNotReadyError extends Error {
  readonly readiness: SchemaReadinessState;

  constructor(readiness: SchemaReadinessState) {
    const detail =
      readiness.status === "pending_migrations"
        ? `pending: ${readiness.pendingMigrations.join(", ")}`
        : readiness.status === "failed_migration"
          ? readiness.error
          : "unknown";
    super(`Schema is not ready (${readiness.status}): ${detail}`);
    this.name = "SchemaNotReadyError";
    this.readiness = readiness;
  }
}

export function assertSchemaReady(readiness: SchemaReadinessState): void {
  if (readiness.status !== "ready") {
    throw new SchemaNotReadyError(readiness);
  }
}

/**
 * Shared gate for background processors. Watcher, ingestion, and outbox
 * must refuse to run when migrations are pending or previously failed.
 */
export function assertProcessingAllowed(
  readiness: SchemaReadinessState,
  processor: "watcher" | "ingestion" | "outbox",
): void {
  if (readiness.status === "ready") {
    return;
  }

  if (readiness.status === "failed_migration") {
    throw new SchemaNotReadyError({
      status: "failed_migration",
      error: `${processor} blocked: ${readiness.error}`,
      appliedMigrations: readiness.appliedMigrations,
    });
  }

  throw new SchemaNotReadyError({
    status: "pending_migrations",
    pendingMigrations: readiness.pendingMigrations,
    appliedMigrations: readiness.appliedMigrations,
  });
}
