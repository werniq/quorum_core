import { createHmac } from "node:crypto";
import type { QuorumEnv } from "../config/env.js";

/**
 * Secret for pseudonymizing outcome identifiers.
 * Distinct from heartbeat HMAC credentials. Prefer QUORUM_IDENTIFIER_HMAC_KEY;
 * otherwise derive from the credential KEK with a fixed context string.
 */
export function resolveIdentifierHmacKey(env: QuorumEnv): string {
  const configured = env.QUORUM_IDENTIFIER_HMAC_KEY?.trim() ?? "";
  if (configured.length >= 16) {
    return configured;
  }
  return createHmac("sha256", env.QUORUM_CREDENTIAL_KEK)
    .update("quorum-identifier-v1", "utf8")
    .digest("hex");
}
