import { describe, expect, it } from "vitest";
import {
  emptyOnboardingDraft,
  selectedWorkflowConfigs,
  type OnboardingDraft,
  type OnboardingWorkflowConfig,
} from "../../src/domain/onboarding/draft.js";

function config(id: string): OnboardingWorkflowConfig {
  return {
    externalWorkflowId: id,
    name: id,
    activeInN8n: true,
    triggerSummary: "Every minute",
    cadenceType: "interval",
    cadenceValue: "1m",
    timezone: "UTC",
    quietHours: null,
    monitorMissingRuns: true,
    monitorFailures: true,
    monitorEmptyResult: false,
    monitorVolumeRange: false,
    volumeMin: null,
    volumeMax: null,
    monitoringMethod: "poll",
  };
}

describe("onboarding workflow selection", () => {
  it("initializes with an empty explicit selection", () => {
    expect(emptyOnboardingDraft().selectedExternalWorkflowIds).toEqual([]);
  });

  it("one selection produces exactly one workflow on the next step", () => {
    const draft: OnboardingDraft = {
      selectedExternalWorkflowIds: ["acme"],
      workflowConfigs: {
        protected: config("protected"),
        acme: config("acme"),
        unselected: config("unselected"),
      },
    };

    expect(
      selectedWorkflowConfigs(draft).map((item) => item.externalWorkflowId),
    ).toEqual(["acme"]);
  });

  it("does not include unselected workflows in the submitted configuration", () => {
    const draft: OnboardingDraft = {
      selectedExternalWorkflowIds: ["acme"],
      workflowConfigs: {
        acme: config("acme"),
        soak: config("soak"),
      },
    };

    expect(selectedWorkflowConfigs(draft)).not.toContainEqual(config("soak"));
  });

  it("preserves only explicit selections after back navigation", () => {
    const draft: OnboardingDraft = {
      selectedExternalWorkflowIds: ["acme"],
      workflowConfigs: {
        protected: config("protected"),
        acme: config("acme"),
        soak: config("soak"),
      },
    };
    const persisted = JSON.parse(JSON.stringify(draft)) as OnboardingDraft;

    expect(
      selectedWorkflowConfigs(persisted).map((item) => item.externalWorkflowId),
    ).toEqual(["acme"]);
  });

  it("builds the final request payload from explicit workflow IDs only", () => {
    const draft: OnboardingDraft = {
      selectedExternalWorkflowIds: ["acme", "acme"],
      workflowConfigs: {
        protected: config("protected"),
        acme: config("acme"),
        soak: config("soak"),
      },
    };

    expect(selectedWorkflowConfigs(draft)).toEqual([config("acme")]);
  });
});
