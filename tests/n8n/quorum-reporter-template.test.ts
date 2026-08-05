import { describe, expect, it } from "vitest";
import { quorumReporterTemplateJson } from "../../src/infrastructure/n8n/quorum-reporter-template.js";

describe("Quorum Reporter template", () => {
  it("accepts the simplified inputs and never embeds a real secret", () => {
    const raw = quorumReporterTemplateJson();
    const template = JSON.parse(raw) as {
      name: string;
      nodes: Array<{ name: string }>;
      meta: { quorumReporterInputs: string[] };
    };

    expect(template.name).toBe("Quorum Reporter");
    expect(template.meta.quorumReporterInputs).toEqual([
      "quorumWorkflowId",
      "keyId",
      "status",
      "itemsProcessed",
      "externalExecutionRef (optional)",
    ]);
    expect(template.nodes.map((node) => node.name)).toContain(
      "Require HTTP 202",
    );
    expect(raw).not.toContain("workflow-hmac-secret");
    expect(raw).not.toContain("super-secret");
    expect(raw).toContain("REPLACE_IN_N8N_OR_ATTACH_CRYPTO_CREDENTIAL");
  });
});
