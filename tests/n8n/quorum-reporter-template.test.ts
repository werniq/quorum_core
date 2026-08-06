import { describe, expect, it } from "vitest";
import { quorumReporterTemplateJson } from "../../src/infrastructure/n8n/quorum-reporter-template.js";

const options = {
  quorumBaseUrl: "https://quorum.example.test/",
  workflowId: "workflow_production_1",
  keyId: "key_current",
  outputMonitoringEnabled: true,
};

describe("generated Quorum Reporter workflow", () => {
  it("preconfigures the workflow, current key, base URL, and ingest endpoint", () => {
    const template = JSON.parse(quorumReporterTemplateJson(options)) as {
      name: string;
      nodes: Array<{ name: string; parameters: Record<string, unknown> }>;
      meta: {
        quorumReporter: Record<string, unknown>;
        inputExamples: Record<string, Record<string, string>>;
      };
    };

    expect(template.name).toContain(options.workflowId);
    expect(template.meta.quorumReporter).toMatchObject({
      workflowId: options.workflowId,
      keyId: options.keyId,
      ingestPath: `/api/v1/workflows/${options.workflowId}/heartbeats`,
      outputMonitoringEnabled: true,
      secretIncluded: false,
    });
    const raw = JSON.stringify(template);
    expect(raw).toContain("https://quorum.example.test");
    expect(raw).toContain("Report result to Quorum");
    expect(raw).toContain("Confirm report accepted");
  });

  it("never embeds a supplied or recognizable real HMAC secret", () => {
    const raw = quorumReporterTemplateJson(options);
    expect(raw).not.toContain("workflow-hmac-secret");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("one-time-heartbeat-secret");
    expect(raw).toContain("PASTE_HMAC_SECRET_OR_USE_N8N_CREDENTIAL");
  });

  it("includes incoming-item and numeric-expression count modes", () => {
    const template = JSON.parse(quorumReporterTemplateJson(options)) as {
      meta: { inputExamples: Record<string, Record<string, string>> };
    };
    expect(template.meta.inputExamples.incomingItems?.itemsProcessed).toBe(
      "={{ $input.all().length }}",
    );
    expect(template.meta.inputExamples.numericExpression?.itemsProcessed).toBe(
      "={{ $json.crmRecordsCreated }}",
    );
  });

  it("uses the real n8n execution ID and validates output evidence distinctly", () => {
    const template = JSON.parse(quorumReporterTemplateJson(options)) as {
      nodes: Array<{ name: string; parameters: { jsCode?: string } }>;
    };
    const code = template.nodes.find(
      (node) => node.name === "Build and validate report",
    )?.parameters.jsCode;
    expect(code).toContain("$execution.id");
    expect(code).toContain("externalExecutionRef = String($execution.id)");
    expect(code).not.toContain("input.externalExecutionRef ||");
    expect(code).not.toContain("externalExecutionRef = `n8n-${Date.now()}`");
    expect(code).toContain("Output evidence missing");
    expect(code).toContain("Number.isInteger(itemsProcessed)");
    expect(code).toContain("itemsProcessed < 0");
    expect(code).toContain("body.itemsProcessed = itemsProcessed");
    expect(code).not.toContain("itemsProcessed || 0");
  });
});
