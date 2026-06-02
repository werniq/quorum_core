/**
 * Local structured logging helpers.
 * Self-hosted: never transmit logs; never include secrets or PII payloads.
 */

const SECRET_PATTERNS = [
  /authorization:\s*\S+/gi,
  /bearer\s+[a-z0-9._~+/=-]+/gi,
  /(?:api[_-]?key|secret|password|token|hmac)\s*[:=]\s*\S+/gi,
  /v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+/g,
];

export function redactSensitiveText(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

export type StructuredLogFields = {
  requestId?: string;
  tenantId?: string;
  clientId?: string;
  contractId?: string;
  workflowId?: string;
  outcomeContractId?: string;
  incidentId?: string;
  connectorId?: string;
  outboxId?: string;
  attemptId?: string;
  event?: string;
  errorCategory?: string;
};

/** Drop undefined and ensure no secret-looking freeform values. */
export function sanitizeLogFields(
  fields: StructuredLogFields & Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (
      key.toLowerCase().includes("secret") ||
      key.toLowerCase().includes("password") ||
      key.toLowerCase().includes("authorization") ||
      key === "token" ||
      key === "rawToken"
    ) {
      continue;
    }
    out[key] = redactSensitiveText(String(value));
  }
  return out;
}

export const PINO_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "body.password",
  "body.setupToken",
  "body.apiKey",
  "body.secret",
  "body.token",
];
