import type { FastifyInstance } from "fastify";
import type { IngestHeartbeatResult } from "../../ingestion/ingest-heartbeat.js";

export function registerHeartbeatRoutes(
  app: FastifyInstance,
  deps: {
    ingest: (command: {
      workflowId: string;
      method: string;
      path: string;
      keyId: string;
      timestampSeconds: string;
      idempotencyKey: string;
      signatureHex: string;
      rawBody: Buffer;
    }) => IngestHeartbeatResult;
    maxBodyBytes: number;
  },
): void {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: deps.maxBodyBytes },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Params: { workflow_id: string } }>(
    "/api/v1/workflows/:workflow_id/heartbeats",
    async (request, reply) => {
      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        return reply.code(400).send({ error: { code: "INVALID_BODY" } });
      }

      const keyId = headerValue(request.headers["x-quorum-key-id"]);
      const timestamp = headerValue(request.headers["x-quorum-timestamp"]);
      const idempotencyKey = headerValue(
        request.headers["x-quorum-idempotency-key"],
      );
      const signature = headerValue(request.headers["x-quorum-signature"]);

      if (!keyId || !timestamp || !idempotencyKey || !signature) {
        return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
      }

      const result = deps.ingest({
        workflowId: request.params.workflow_id,
        method: request.method,
        path: request.url.split("?")[0] ?? request.url,
        keyId,
        timestampSeconds: timestamp,
        idempotencyKey,
        signatureHex: signature,
        rawBody,
      });

      return mapIngestResult(reply, result);
    },
  );
}

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0].trim();
  }
  return null;
}

function mapIngestResult(
  reply: {
    code: (statusCode: number) => {
      send: (payload: Record<string, unknown>) => unknown;
    };
  },
  result: IngestHeartbeatResult,
) {
  switch (result.status) {
    case "accepted":
      return reply.code(202).send({
        status: "accepted",
        eventId: result.eventId,
        idempotentReplay: result.idempotentReplay,
      });
    case "conflict":
      return reply.code(409).send({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    case "unauthorized":
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    case "not_found":
      return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    case "contract_not_active":
      return reply.code(409).send({
        error: {
          code: "CONTRACT_NOT_ACTIVE",
          message: result.message,
        },
      });
    case "bad_request":
      return reply.code(400).send({ error: { code: result.code } });
    case "rate_limited":
      return reply.code(429).send({ error: { code: "RATE_LIMITED" } });
    case "not_ready":
      return reply.code(503).send({ error: { code: "NOT_READY" } });
  }
}
