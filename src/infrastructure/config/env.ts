import { z } from "zod";
import { EDITIONS } from "../../domain/terminology.js";

const optionalPositiveInt = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined || value === "") {
      return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "Expected a positive integer",
      });
      return z.NEVER;
    }
    return parsed;
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  QUORUM_EDITION: z.enum(EDITIONS).default("self_hosted"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  /** SQLite file path for self-hosted (default). */
  DATABASE_URL: z.string().min(1).default("file:./data/quorum.sqlite"),
  /**
   * Self-hosted invariant: telemetry must remain disabled.
   * Any non-false value in self_hosted edition is rejected.
   */
  QUORUM_TELEMETRY_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Key-encryption key for per-workflow HMAC secrets (never log this). */
  QUORUM_CREDENTIAL_KEK: z
    .string()
    .min(16)
    .default("quorum-dev-credential-kek"),
  HEARTBEAT_TIMESTAMP_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  HEARTBEAT_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  HEARTBEAT_RATE_LIMIT_BURST: z.coerce.number().int().nonnegative().default(20),
  HEARTBEAT_SUSTAINED_REJECTION_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  HEARTBEAT_MAX_BODY_BYTES: z.coerce.number().int().positive().default(65536),
  HEARTBEAT_TENANT_RATE_LIMIT_PER_MINUTE: optionalPositiveInt,
  HEARTBEAT_GLOBAL_RATE_LIMIT_PER_MINUTE: optionalPositiveInt,
  /** Hosted n8n public polling egress limits. */
  N8N_CONNECTOR_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5_000),
  N8N_CONNECTOR_READ_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  N8N_CONNECTOR_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_048_576),
  N8N_CONNECTOR_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),
  /** How often the n8n poll scheduler wakes to claim due workflows. */
  N8N_POLL_SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15_000),
  /** Default per-connector poll cadence when creating connectors. */
  N8N_POLL_DEFAULT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  /** Exclusive claim TTL while a poll is in flight. */
  N8N_POLL_CLAIM_TTL_MS: z.coerce.number().int().positive().default(55_000),
  /** Watcher evaluation interval and staleness for /health/watcher. */
  WATCHER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WATCHER_STALE_MS: z.coerce.number().int().positive().default(180_000),
  WATCHER_CLAIM_TTL_MS: z.coerce.number().int().positive().default(55_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  OUTBOX_CLAIM_TTL_MS: z.coerce.number().int().positive().default(30_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_RETRY_BASE_MS: z.coerce.number().int().positive().default(30_000),
  ALERT_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(10_000),
  PUBLIC_BASE_URL: z.string().default("http://127.0.0.1:3000"),
  /** Previous KEK during rotation window (optional). */
  QUORUM_CREDENTIAL_KEK_PREVIOUS: z.string().optional().default(""),
  /**
   * Keyed HMAC secret for outcome identifier pseudonyms.
   * Distinct from heartbeat credentials. Empty → derived from KEK.
   */
  QUORUM_IDENTIFIER_HMAC_KEY: z.string().optional().default(""),
  /** Expose /metrics. Default false. Prefer METRICS_AUTH_TOKEN when enabled. */
  METRICS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** Bearer token required for /metrics when set. Loopback allowed without token. */
  METRICS_AUTH_TOKEN: z.string().optional().default(""),
});

export type QuorumEnv = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid environment configuration: ${issues.join("; ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): QuorumEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "env"}: ${issue.message}`,
      ),
    );
  }

  const env = parsed.data;
  if (env.QUORUM_EDITION === "self_hosted" && env.QUORUM_TELEMETRY_ENABLED) {
    throw new EnvValidationError([
      "QUORUM_TELEMETRY_ENABLED: self-hosted edition forbids telemetry",
    ]);
  }

  return env;
}
