import {
  connectorErrorCodeFromHttpStatus,
  sanitizeRemoteErrorMessage,
} from "../../domain/connectors/sanitize-remote-error.js";
import type { ConnectorHealth } from "../../domain/connectors/types.js";
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
      return mapHttpFailure(response.status, response.bodyText);
    }
    if (response.status < 200 || response.status >= 300) {
      return mapHttpFailure(response.status, response.bodyText);
    }
    let workflowCountHint: number | null = null;
    try {
      const parsed = JSON.parse(response.bodyText) as { data?: unknown[] };
      if (Array.isArray(parsed.data)) {
        workflowCountHint = parsed.data.length;
      }
    } catch {
      workflowCountHint = null;
    }
    return { ok: true, value: { workflowCountHint } };
  } catch (error) {
    return mapTransportError(error);
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
