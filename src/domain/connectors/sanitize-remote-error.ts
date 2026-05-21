const SECRET_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer\s+[a-z0-9\-._~+/]+=*/i,
  /x-n8n-api-key/i,
];

/**
 * Produces a safe operator-facing error summary.
 * Strips credential-looking tokens and truncates length.
 */
export function sanitizeRemoteErrorMessage(
  message: string,
  options?: { maxLength?: number },
): string {
  const maxLength = options?.maxLength ?? 240;
  let cleaned = message.replace(/[\r\n\t]+/g, " ").trim();
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, "[redacted]");
  }
  // Redact long opaque tokens that look like secrets (not snake_case codes).
  cleaned = cleaned.replace(/\b[A-Za-z0-9+/=_-]{24,}\b/g, (token) => {
    if (/^[a-z0-9_]+$/.test(token)) {
      return token;
    }
    return "[redacted]";
  });
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength - 1)}…`;
  }
  return cleaned.length > 0 ? cleaned : "remote_error";
}

export function connectorErrorCodeFromHttpStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "auth_failed";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status >= 500) {
    return "upstream_error";
  }
  if (status >= 400) {
    return "client_error";
  }
  return "unexpected_status";
}
