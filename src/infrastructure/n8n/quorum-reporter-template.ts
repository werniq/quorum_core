export interface QuorumReporterTemplateOptions {
  quorumBaseUrl: string;
  workflowId: string;
  keyId: string;
  ingestPath?: string;
  outputMonitoringEnabled?: boolean;
}

/** Importable n8n reporter sub-workflow. It intentionally contains no credential secret. */
export function quorumReporterTemplateJson(
  options: QuorumReporterTemplateOptions,
): string {
  const ingestPath =
    options.ingestPath ??
    `/api/v1/workflows/${encodeURIComponent(options.workflowId)}/heartbeats`;
  const configuration = {
    quorumBaseUrl: options.quorumBaseUrl.replace(/\/+$/, ""),
    quorumWorkflowId: options.workflowId,
    keyId: options.keyId,
    ingestPath,
    outputMonitoringEnabled: options.outputMonitoringEnabled === true,
  };
  const prepareCode = `const config = ${JSON.stringify(configuration)};
const input = $json;
const status = input.status ?? 'success';
if (status !== 'success' && status !== 'failure') {
  throw new Error('Quorum Reporter: status must be success or failure.');
}
const suppliedCount = input.itemsProcessed;
if (config.outputMonitoringEnabled && (suppliedCount === undefined || suppliedCount === null || suppliedCount === '')) {
  throw new Error('Quorum Reporter: Output evidence missing. Provide itemsProcessed when output monitoring is enabled.');
}
let itemsProcessed;
if (suppliedCount !== undefined && suppliedCount !== null && suppliedCount !== '') {
  itemsProcessed = Number(suppliedCount);
  if (!Number.isFinite(itemsProcessed) || !Number.isInteger(itemsProcessed) || itemsProcessed < 0) {
    throw new Error('Quorum Reporter: itemsProcessed must be an integer zero or greater.');
  }
}
const executedAt = new Date().toISOString();
const externalExecutionRef = String($execution.id);
const timestampSeconds = String(Math.floor(Date.now() / 1000));
const idempotencyKey = String(input.idempotencyKey || ('n8n-' + externalExecutionRef));
const body = { schemaVersion: 1, executedAt, status, externalExecutionRef };
if (itemsProcessed !== undefined) body.itemsProcessed = itemsProcessed;
const bodyRaw = JSON.stringify(body);
return [{ json: { ...config, url: config.quorumBaseUrl + config.ingestPath, timestampSeconds, idempotencyKey, bodyRaw } }];`;
  const signingCode = `const signingPayload = ['POST', $json.ingestPath, $json.timestampSeconds, $json.idempotencyKey, $json.bodySha256Hex].join('\\n');
return [{ json: { ...$json, signingPayload } }];`;
  const validateCode = `if (Number($json.statusCode) !== 202) {
  const detail = typeof $json.body === 'string' ? $json.body : JSON.stringify($json.body || {});
  throw new Error('Quorum rejected the report (HTTP ' + String($json.statusCode || 'unknown') + '): ' + detail);
}
return $input.all();`;
  return JSON.stringify(
    {
      name: `Quorum Reporter — ${options.workflowId}`,
      active: false,
      nodes: [
        {
          parameters: {
            content:
              "## Quorum Reporter\nReusable reporting sub-workflow. In the business workflow, add one Execute Sub-workflow node named **Report result to Quorum** and pass status plus itemsProcessed.",
            height: 220,
            width: 420,
          },
          id: "reporter-overview",
          name: "How to use this reporter",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [-20, -300],
        },
        {
          parameters: {
            content: `## Configuration\nQuorum workflow: ${options.workflowId}\nKey ID: ${options.keyId}\nEndpoint: POST ${ingestPath}\n\nAdd the HMAC secret to the **Sign request** node after import. Never export or commit the configured workflow.`,
            height: 220,
            width: 440,
          },
          id: "reporter-configuration",
          name: "Reporter configuration",
          type: "n8n-nodes-base.stickyNote",
          typeVersion: 1,
          position: [760, -300],
        },
        {
          parameters: {},
          id: "report-input",
          name: "Report result to Quorum",
          type: "n8n-nodes-base.executeWorkflowTrigger",
          typeVersion: 1.1,
          position: [0, 0],
        },
        {
          parameters: { jsCode: prepareCode },
          id: "prepare-report",
          name: "Build and validate report",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [240, 0],
        },
        {
          parameters: {
            action: "hash",
            type: "SHA256",
            binaryData: false,
            value: "={{ $json.bodyRaw }}",
            dataPropertyName: "bodySha256Hex",
            encoding: "hex",
          },
          id: "hash-body",
          name: "Hash request body",
          type: "n8n-nodes-base.crypto",
          typeVersion: 1,
          position: [480, 0],
        },
        {
          parameters: { jsCode: signingCode },
          id: "compose-signature",
          name: "Build canonical signature payload",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [720, 0],
        },
        {
          parameters: {
            action: "hmac",
            type: "SHA256",
            binaryData: false,
            value: "={{ $json.signingPayload }}",
            dataPropertyName: "signature",
            secret: "PASTE_HMAC_SECRET_OR_USE_N8N_CREDENTIAL",
            encoding: "hex",
          },
          id: "sign-report",
          name: "Sign request",
          type: "n8n-nodes-base.crypto",
          typeVersion: 1,
          position: [980, 0],
          notes:
            "Store the HMAC secret in an n8n credential when supported. Otherwise paste the one-time secret here, then never export or commit this configured workflow.",
        },
        {
          parameters: {
            method: "POST",
            url: "={{$json.url}}",
            sendHeaders: true,
            headerParameters: {
              parameters: [
                { name: "content-type", value: "application/json" },
                { name: "x-quorum-key-id", value: "={{$json.keyId}}" },
                {
                  name: "x-quorum-timestamp",
                  value: "={{$json.timestampSeconds}}",
                },
                {
                  name: "x-quorum-idempotency-key",
                  value: "={{$json.idempotencyKey}}",
                },
                { name: "x-quorum-signature", value: "={{$json.signature}}" },
              ],
            },
            sendBody: true,
            contentType: "raw",
            rawContentType: "application/json",
            body: "={{$json.bodyRaw}}",
            options: { response: { response: { fullResponse: true } } },
          },
          id: "send-report",
          name: "Send report to Quorum",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [1220, 0],
        },
        {
          parameters: { jsCode: validateCode },
          id: "validate-response",
          name: "Confirm report accepted",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [1460, 0],
        },
      ],
      connections: {
        "Report result to Quorum": {
          main: [
            [{ node: "Build and validate report", type: "main", index: 0 }],
          ],
        },
        "Build and validate report": {
          main: [[{ node: "Hash request body", type: "main", index: 0 }]],
        },
        "Hash request body": {
          main: [
            [
              {
                node: "Build canonical signature payload",
                type: "main",
                index: 0,
              },
            ],
          ],
        },
        "Build canonical signature payload": {
          main: [[{ node: "Sign request", type: "main", index: 0 }]],
        },
        "Sign request": {
          main: [[{ node: "Send report to Quorum", type: "main", index: 0 }]],
        },
        "Send report to Quorum": {
          main: [[{ node: "Confirm report accepted", type: "main", index: 0 }]],
        },
      },
      settings: { executionOrder: "v1" },
      meta: {
        quorumReporter: {
          workflowId: options.workflowId,
          keyId: options.keyId,
          ingestPath,
          outputMonitoringEnabled: configuration.outputMonitoringEnabled,
          secretIncluded: false,
        },
        inputExamples: {
          incomingItems: {
            status: "success",
            itemsProcessed: "={{ $input.all().length }}",
            externalExecutionRef: "={{ $execution.id }}",
          },
          numericExpression: {
            status: "success",
            itemsProcessed: "={{ $json.crmRecordsCreated }}",
            externalExecutionRef: "={{ $execution.id }}",
          },
        },
      },
    },
    null,
    2,
  );
}
