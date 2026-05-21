/**
 * Public poll URLs must pass SSRF checks before any connector row is created.
 * Push mode never stores an egress URL for private n8n.
 */

export type ConnectorValidationResult =
  | { ok: true; normalizedBaseUrl: string }
  | { ok: false; code: string; message: string };

export function validateHostedPollBaseUrl(
  rawUrl: string,
  assertPublicHttpsUrl: (raw: string) => URL,
): ConnectorValidationResult {
  try {
    const url = assertPublicHttpsUrl(rawUrl);
    // Normalize trailing slash for storage consistency.
    const normalized = url.toString().replace(/\/$/, "");
    return { ok: true, normalizedBaseUrl: normalized };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code ?? "invalid_url")
        : "invalid_url";
    return {
      ok: false,
      code,
      message:
        "Public n8n polling requires a public HTTPS URL. Private, loopback, link-local, and metadata destinations are blocked.",
    };
  }
}
