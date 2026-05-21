/**
 * Delivery errors stored on attempts/channel state must be sanitized.
 * Never persist raw secrets or credential material in error text.
 */
const SECRET_ASSIGNMENT =
  /(?:api[_-]?key|password|passwd|secret|token|authorization)\s*[:=]\s*\S+/gi;
const BEARER_TOKEN = /bearer\s+\S+/gi;

export function sanitizeDeliveryErrorMessage(
  message: string | null | undefined,
): string | null {
  if (message === null || message === undefined) {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed
    .replace(SECRET_ASSIGNMENT, "[redacted]")
    .replace(BEARER_TOKEN, "[redacted]")
    .slice(0, 500);
}
