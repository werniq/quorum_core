/** Importable n8n sub-workflow. It intentionally contains no credential secret. */
export function quorumReporterTemplateJson(): string {
  const prepareCode = `const required = (name) => {
  const value = $json[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('Quorum Reporter requires ' + name);
  }
  return value;
};
const quorumBaseUrl = 'REPLACE_QUORUM_BASE_URL';
if (quorumBaseUrl.startsWith('REPLACE_')) throw new Error('Set quorumBaseUrl once in Quorum Reporter');
const quorumWorkflowId = String(required('quorumWorkflowId'));
const keyId = String(required('keyId'));
const status = String(required('status'));
const itemsProcessed = Number(required('itemsProcessed'));
const path = '/api/v1/workflows/' + quorumWorkflowId + '/heartbeats';
const timestampSeconds = String(Math.floor(Date.now() / 1000));
const idempotencyKey = String($json.externalExecutionRef || ('quorum-' + timestampSeconds + '-' + Math.random().toString(16).slice(2)));
const bodyRaw = JSON.stringify({ schemaVersion: 1, executedAt: new Date().toISOString(), status, itemsProcessed, externalExecutionRef: $json.externalExecutionRef || undefined });
return [{ json: { url: quorumBaseUrl.replace(/\\/+$/, '') + path, path, keyId, timestampSeconds, idempotencyKey, bodyRaw } }];`;
  const signingCode = `const signingPayload = ['POST', $json.path, $json.timestampSeconds, $json.idempotencyKey, $json.bodySha256Hex].join('\\n');
return [{ json: { ...$json, signingPayload } }];`;
  const validateCode = `if (Number($json.statusCode) !== 202) {
  throw new Error('Quorum rejected the heartbeat (HTTP ' + String($json.statusCode || 'unknown') + '). Check the response body.');
}
return $input.all();`;
  return JSON.stringify(
    {
      name: "Quorum Reporter",
      active: false,
      nodes: [
        {
          parameters: {},
          id: "report-input",
          name: "Called by customer workflow",
          type: "n8n-nodes-base.executeWorkflowTrigger",
          typeVersion: 1.1,
          position: [0, 0],
        },
        {
          parameters: { jsCode: prepareCode },
          id: "prepare-report",
          name: "Prepare Quorum report",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [220, 0],
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
          name: "Hash report body",
          type: "n8n-nodes-base.crypto",
          typeVersion: 1,
          position: [440, 0],
        },
        {
          parameters: { jsCode: signingCode },
          id: "compose-signature",
          name: "Compose signing payload",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [660, 0],
        },
        {
          parameters: {
            action: "hmac",
            type: "SHA256",
            binaryData: false,
            value: "={{ $json.signingPayload }}",
            dataPropertyName: "signature",
            secret: "REPLACE_IN_N8N_OR_ATTACH_CRYPTO_CREDENTIAL",
            encoding: "hex",
          },
          id: "sign-report",
          name: "Sign with Quorum credential",
          type: "n8n-nodes-base.crypto",
          typeVersion: 1,
          position: [880, 0],
          notes:
            "Store the HMAC secret once in an n8n Crypto credential when supported. For legacy Crypto v1, paste it here after import; never export or commit the configured workflow.",
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
                {
                  name: "x-quorum-signature",
                  value: "={{$json.signature}}",
                },
              ],
            },
            sendBody: true,
            contentType: "raw",
            rawContentType: "application/json",
            body: "={{$json.bodyRaw}}",
            options: {
              response: {
                response: { fullResponse: true, neverError: true },
              },
            },
          },
          id: "send-report",
          name: "Send Quorum heartbeat",
          type: "n8n-nodes-base.httpRequest",
          typeVersion: 4.2,
          position: [1100, 0],
        },
        {
          parameters: { jsCode: validateCode },
          id: "validate-response",
          name: "Require HTTP 202",
          type: "n8n-nodes-base.code",
          typeVersion: 2,
          position: [1320, 0],
        },
      ],
      connections: {
        "Called by customer workflow": {
          main: [[{ node: "Prepare Quorum report", type: "main", index: 0 }]],
        },
        "Prepare Quorum report": {
          main: [[{ node: "Hash report body", type: "main", index: 0 }]],
        },
        "Hash report body": {
          main: [[{ node: "Compose signing payload", type: "main", index: 0 }]],
        },
        "Compose signing payload": {
          main: [
            [{ node: "Sign with Quorum credential", type: "main", index: 0 }],
          ],
        },
        "Sign with Quorum credential": {
          main: [[{ node: "Send Quorum heartbeat", type: "main", index: 0 }]],
        },
        "Send Quorum heartbeat": {
          main: [[{ node: "Require HTTP 202", type: "main", index: 0 }]],
        },
      },
      settings: { executionOrder: "v1" },
      meta: {
        quorumReporterInputs: [
          "quorumWorkflowId",
          "keyId",
          "status",
          "itemsProcessed",
          "externalExecutionRef (optional)",
        ],
        security:
          "No real secret is included. Configure the HMAC secret after import and do not export the configured workflow.",
      },
    },
    null,
    2,
  );
}
