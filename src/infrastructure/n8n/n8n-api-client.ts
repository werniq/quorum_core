import {
  connectorErrorCodeFromHttpStatus,
  sanitizeRemoteErrorMessage,
} from "../../domain/connectors/sanitize-remote-error.js";
import type { ConnectorHealth } from "../../domain/connectors/types.js";
import type { DiscoveredWorkflow } from "../../domain/n8n/discovered-workflow.js";
import { inferWorkflowDiscovery } from "../../domain/n8n/infer-cadence.js";
import type { N8nExecutionRecord } from "../../domain/n8n/normalize-execution.js";
import {
  SecureOutboundHttpError,
  secureOutboundGet,
  type SecureOutboundHttpOptions,
} from "../security/secure-outbound-http.js";

export interface N8nConnectorEndpoint {
  baseUrl: string;
  apiKey: string;
}

export type N8nClientResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      health: Exclude<ConnectorHealth, "healthy" | "unknown">;
      code: string;
      summary: string;
    };

function httpOptions(
  options: SecureOutboundHttpOptions,
): SecureOutboundHttpOptions {
  return options;
}

function mapHttpFailure(
  status: number,
  bodyText: string,
): Extract<N8nClientResult<never>, { ok: false }> {
  const code = connectorErrorCodeFromHttpStatus(status);
  const health: Exclude<ConnectorHealth, "healthy" | "unknown"> =
    code === "auth_failed" ? "auth_failed" : "unreachable";
  return {
    ok: false,
    health,
    code,
    summary: sanitizeRemoteErrorMessage(
      bodyText.length > 0 ? `http_${status}: ${bodyText}` : `http_${status}`,
    ),
  };
}

function mapTransportError(
  error: unknown,
): Extract<N8nClientResult<never>, { ok: false }> {
  if (error instanceof SecureOutboundHttpError) {
    const health: Exclude<ConnectorHealth, "healthy" | "unknown"> =
      error.code === "unreachable" ? "unreachable" : "misconfigured";
    return {
      ok: false,
      health,
      code: error.code,
      summary: sanitizeRemoteErrorMessage(error.message),
    };
  }
  return {
    ok: false,
    health: "unreachable",
    code: "unreachable",
    summary: sanitizeRemoteErrorMessage(
      error instanceof Error ? error.message : "request_failed",
    ),
  };
}

function mapUserFacingAuthFailure(
  result: Extract<N8nClientResult<never>, { ok: false }>,
): Extract<N8nClientResult<never>, { ok: false }> {
  if (result.code === "auth_failed") {
    return {
      ...result,
      summary:
        "Quorum reached n8n, but the API key was rejected. Create or copy an n8n API key and try again.",
    };
  }
  if (result.code === "unreachable" || result.health === "unreachable") {
    return {
      ...result,
      summary:
        "Quorum could not connect to this address. Check that n8n is reachable from the Quorum container. If both run in Docker Compose, use the service URL http://n8n:5678 (not localhost).",
    };
  }
  return result;
}

export async function validateN8nConnectorConnectivity(
  endpoint: N8nConnectorEndpoint,
  options: SecureOutboundHttpOptions,
): Promise<N8nClientResult<{ workflowCountHint: number | null }>> {
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  try {
    const response = await secureOutboundGet(
      `${base}/api/v1/workflows?limit=1`,
      {
        Accept: "application/json",
        "X-N8N-API-KEY": endpoint.apiKey,
      },
      httpOptions(options),
    );
    if (response.status === 401 || response.status === 403) {
      return mapUserFacingAuthFailure(
        mapHttpFailure(response.status, response.bodyText),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return mapHttpFailure(response.status, response.bodyText);
    }
    let workflowCountHint: number | null = null;
    try {
      const parsed = JSON.parse(response.bodyText) as {
        data?: unknown[];
        nextCursor?: unknown;
      };
      if (Array.isArray(parsed.data)) {
        workflowCountHint =
          parsed.nextCursor !== undefined && parsed.nextCursor !== null
            ? null
            : parsed.data.length;
      }
    } catch {
      workflowCountHint = null;
    }
    return { ok: true, value: { workflowCountHint } };
  } catch (error) {
    return mapUserFacingAuthFailure(mapTransportError(error));
  }
}

const MAX_DISCOVERED_WORKFLOWS = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Prefer published/active nodes when n8n returns versioned workflows.
 * List payloads may omit full schedule parameters; callers should detail-fetch.
 */
export function nodesFromWorkflowPayload(
  workflow: Record<string, unknown>,
): unknown {
  const activeVersion = asRecord(workflow.activeVersion);
  if (activeVersion && Array.isArray(activeVersion.nodes)) {
    return activeVersion.nodes;
  }
  const version = asRecord(workflow.version);
  if (version && Array.isArray(version.nodes)) {
    return version.nodes;
  }
  return workflow.nodes;
}

async function fetchN8nWorkflowDetail(input: {
  baseUrl: string;
  apiKey: string;
  workflowId: string;
  options: SecureOutboundHttpOptions;
}): Promise<Record<string, unknown> | null> {
  const response = await secureOutboundGet(
    `${input.baseUrl}/api/v1/workflows/${encodeURIComponent(input.workflowId)}`,
    {
      Accept: "application/json",
      "X-N8N-API-KEY": input.apiKey,
    },
    httpOptions(input.options),
  );
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  try {
    const parsed = JSON.parse(response.bodyText) as unknown;
    const root = asRecord(parsed);
    if (!root) {
      return null;
    }
    // Some n8n versions wrap the workflow: { data: { ...workflow } }
    const nested = asRecord(root.data);
    if (nested && (nested.nodes != null || nested.activeVersion != null)) {
      return nested;
    }
    return root;
  } catch {
    return null;
  }
}

/**
 * Lists workflows from n8n with pagination. Returns normalized discovery DTOs.
 * Caps results to avoid unbounded DB/UI work from untrusted upstream.
 * Fetches each workflow detail so schedule node parameters are present
 * (list responses often include names but incomplete trigger config).
 */
export async function listN8nWorkflows(input: {
  endpoint: N8nConnectorEndpoint;
  options: SecureOutboundHttpOptions;
  pageSize?: number;
  maxWorkflows?: number;
}): Promise<N8nClientResult<DiscoveredWorkflow[]>> {
  const base = input.endpoint.baseUrl.replace(/\/+$/, "");
  const pageSize = Math.min(Math.max(input.pageSize ?? 50, 1), 100);
  const maxWorkflows = Math.min(
    input.maxWorkflows ?? MAX_DISCOVERED_WORKFLOWS,
    MAX_DISCOVERED_WORKFLOWS,
  );
  const discovered: DiscoveredWorkflow[] = [];
  const seenIds = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  const maxPages = Math.ceil(maxWorkflows / pageSize) + 1;

  try {
    while (pages < maxPages && discovered.length < maxWorkflows) {
      pages += 1;
      const url =
        cursor === null
          ? `${base}/api/v1/workflows?limit=${pageSize}`
          : `${base}/api/v1/workflows?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`;
      const response = await secureOutboundGet(
        url,
        {
          Accept: "application/json",
          "X-N8N-API-KEY": input.endpoint.apiKey,
        },
        httpOptions(input.options),
      );
      if (response.status === 401 || response.status === 403) {
        return mapUserFacingAuthFailure(
          mapHttpFailure(response.status, response.bodyText),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return mapHttpFailure(response.status, response.bodyText);
      }

      let parsed: {
        data?: Array<Record<string, unknown>>;
        nextCursor?: string | null;
      };
      try {
        parsed = JSON.parse(response.bodyText) as typeof parsed;
      } catch {
        return {
          ok: false,
          health: "misconfigured",
          code: "invalid_json",
          summary: "n8n returned a malformed workflow list response.",
        };
      }
      if (!Array.isArray(parsed.data)) {
        return {
          ok: false,
          health: "misconfigured",
          code: "invalid_payload",
          summary: "n8n workflow list payload was missing a data array.",
        };
      }

      for (const row of parsed.data) {
        if (discovered.length >= maxWorkflows) {
          break;
        }
        const idRaw = row.id;
        const externalWorkflowId =
          typeof idRaw === "string" || typeof idRaw === "number"
            ? String(idRaw)
            : "";
        if (!externalWorkflowId || seenIds.has(externalWorkflowId)) {
          continue;
        }
        seenIds.add(externalWorkflowId);

        const detail = await fetchN8nWorkflowDetail({
          baseUrl: base,
          apiKey: input.endpoint.apiKey,
          workflowId: externalWorkflowId,
          options: input.options,
        });
        const source = detail ?? row;
        const name =
          typeof source.name === "string" && source.name.trim().length > 0
            ? source.name.trim().slice(0, 200)
            : typeof row.name === "string" && row.name.trim().length > 0
              ? row.name.trim().slice(0, 200)
              : `Workflow ${externalWorkflowId}`;
        const active =
          source.active === true || (detail == null && row.active === true);
        discovered.push(
          inferWorkflowDiscovery({
            externalWorkflowId,
            name,
            active,
            nodes: nodesFromWorkflowPayload(source),
          }),
        );
      }

      const next =
        typeof parsed.nextCursor === "string" && parsed.nextCursor.length > 0
          ? parsed.nextCursor
          : null;
      if (!next || parsed.data.length === 0) {
        break;
      }
      cursor = next;
    }

    return { ok: true, value: discovered };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        health: "misconfigured",
        code: "invalid_json",
        summary: "n8n returned invalid JSON while listing workflows.",
      };
    }
    return mapUserFacingAuthFailure(mapTransportError(error));
  }
}

export async function listN8nExecutions(input: {
  endpoint: N8nConnectorEndpoint;
  externalWorkflowId: string;
  options: SecureOutboundHttpOptions;
  /** Fetch newest first; caller applies checkpoint filtering. */
  limit?: number;
}): Promise<N8nClientResult<N8nExecutionRecord[]>> {
  const base = input.endpoint.baseUrl.replace(/\/+$/, "");
  const limit = input.limit ?? 50;
  const url =
    `${base}/api/v1/executions?workflowId=${encodeURIComponent(input.externalWorkflowId)}` +
    `&limit=${limit}&includeData=false`;

  try {
    const response = await secureOutboundGet(
      url,
      {
        Accept: "application/json",
        "X-N8N-API-KEY": input.endpoint.apiKey,
      },
      httpOptions(input.options),
    );
    if (response.status === 401 || response.status === 403) {
      return mapHttpFailure(response.status, response.bodyText);
    }
    if (response.status < 200 || response.status >= 300) {
      return mapHttpFailure(response.status, response.bodyText);
    }
    const parsed = JSON.parse(response.bodyText) as {
      data?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(parsed.data)) {
      return {
        ok: false,
        health: "misconfigured",
        code: "invalid_payload",
        summary: "executions_payload_invalid",
      };
    }
    const executions: N8nExecutionRecord[] = parsed.data.map((row) => {
      const record: N8nExecutionRecord = {
        id: row.id as string | number,
      };
      if (typeof row.finished === "boolean") {
        record.finished = row.finished;
      }
      if (typeof row.status === "string") {
        record.status = row.status;
      }
      if (typeof row.startedAt === "string") {
        record.startedAt = row.startedAt;
      } else if (row.startedAt === null) {
        record.startedAt = null;
      }
      if (typeof row.stoppedAt === "string") {
        record.stoppedAt = row.stoppedAt;
      } else if (row.stoppedAt === null) {
        record.stoppedAt = null;
      }
      if (
        typeof row.workflowId === "string" ||
        typeof row.workflowId === "number"
      ) {
        record.workflowId = row.workflowId;
      }
      return record;
    });
    return { ok: true, value: executions };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        ok: false,
        health: "misconfigured",
        code: "invalid_json",
        summary: "executions_json_invalid",
      };
    }
    return mapTransportError(error);
  }
}
