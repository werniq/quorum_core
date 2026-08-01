export type ConnectorHealth =
  | "unknown"
  | "healthy"
  | "auth_failed"
  | "unreachable"
  | "misconfigured";

export type ConnectorStatus = "active" | "disabled";

export type ConnectorAuthMode = "api_key";

export interface ConnectorHealthView {
  health: ConnectorHealth;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  /** Sanitized operator-facing summary; never contains secrets. */
  lastErrorSummary: string | null;
  unknownReason: string | null;
  firstFailureAt: Date | null;
  latestFailureAt: Date | null;
}

/** Public polling targets must use HTTPS and non-private destinations. */
export type ConnectorEgressPolicy = "public_https_only";
