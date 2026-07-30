/**
 * Safe browser links into the n8n editor UI.
 * Validates the configured base URL and external workflow id before joining them.
 */

export const SILENT_ABSENCE_MESSAGE =
  "Quorum has not received a new execution within the expected window. The workflow may be stopped, failing before reporting, or unable to reach Quorum.";

/** n8n workflow ids are opaque alphanumeric tokens (optionally with _ / -). */
export function isValidN8nExternalWorkflowId(id: string): boolean {
  const trimmed = id.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(trimmed);
}

/**
 * Build an n8n workflow editor URL, or null when the base URL / external id
 * cannot be trusted for a browser navigation.
 */
export function buildN8nWorkflowEditorUrl(input: {
  baseUrl: string | null | undefined;
  externalWorkflowId: string | null | undefined;
}): string | null {
  const baseRaw = input.baseUrl?.trim() ?? "";
  const externalId = input.externalWorkflowId?.trim() ?? "";
  if (!baseRaw || !externalId) {
    return null;
  }
  if (!isValidN8nExternalWorkflowId(externalId)) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(baseRaw);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  if (!url.hostname) {
    return null;
  }

  const path = url.pathname.replace(/\/+$/, "");
  const originAndPath = `${url.protocol}//${url.host}${path}`;
  return `${originAndPath}/workflow/${encodeURIComponent(externalId)}`;
}
