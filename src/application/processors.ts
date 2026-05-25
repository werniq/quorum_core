import {
  assertProcessingAllowed,
  assertSchemaReady,
  type SchemaReadinessState,
} from "./schema-readiness.js";

/**
 * Processor entry points share the schema readiness gate.
 * Callers pass a runner that performs the real watcher/outbox work.
 */
export function startWatcher(
  readiness: SchemaReadinessState,
  runner?: () => void,
): void {
  assertProcessingAllowed(readiness, "watcher");
  runner?.();
}

export function startIngestion(readiness: SchemaReadinessState): void {
  assertProcessingAllowed(readiness, "ingestion");
}

export function startOutboxProcessing(
  readiness: SchemaReadinessState,
  runner?: () => void | Promise<void>,
): void | Promise<void> {
  assertProcessingAllowed(readiness, "outbox");
  return runner?.();
}

export function assertApplicationReady(readiness: SchemaReadinessState): void {
  assertSchemaReady(readiness);
}
