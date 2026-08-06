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

/** n8n execution ids are positive decimal identifiers. */
export function isValidN8nExecutionId(id: string): boolean {
  const trimmed = id.trim();
  return /^[1-9]\d{0,19}$/.test(trimmed);
}

function trustedN8nBaseUrl(baseUrl: string | null | undefined): string | null {
  const baseRaw = baseUrl?.trim() ?? "";
  if (!baseRaw) return null;
  let url: URL;
  try {
    url = new URL(baseRaw);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Build an n8n workflow editor URL, or null when the base URL / external id
 * cannot be trusted for a browser navigation.
 */
export function buildN8nWorkflowEditorUrl(input: {
  baseUrl: string | null | undefined;
  externalWorkflowId: string | null | undefined;
}): string | null {
  const externalId = input.externalWorkflowId?.trim() ?? "";
  const base = trustedN8nBaseUrl(input.baseUrl);
  if (!base || !externalId) {
    return null;
  }
  if (!isValidN8nExternalWorkflowId(externalId)) {
    return null;
  }

  return `${base}/workflow/${encodeURIComponent(externalId)}`;
}

/** Build an execution link exclusively from connector configuration and a stored id. */
export function buildN8nExecutionUrl(input: {
  baseUrl: string | null | undefined;
  externalWorkflowId: string | null | undefined;
  externalExecutionRef: string | null | undefined;
}): string | null {
  const workflowId = input.externalWorkflowId?.trim() ?? "";
  const executionId = input.externalExecutionRef?.trim() ?? "";
  const base = trustedN8nBaseUrl(input.baseUrl);
  if (
    !base ||
    !isValidN8nExternalWorkflowId(workflowId) ||
    !isValidN8nExecutionId(executionId)
  ) {
    return null;
  }
  return `${base}/workflow/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`;
}
