/**
 * Shared helpers for HTML form mutation errors (self-hosted UI).
 */

export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error && error.code != null ? String(error.code) : "";
  const message =
    error instanceof Error
      ? error.message
      : "message" in error
        ? String(error.message)
        : String(error);
  return (
    code.includes("CONSTRAINT") ||
    /UNIQUE constraint failed/i.test(message) ||
    /duplicate key value/i.test(message)
  );
}

export function workflowRegistrationErrorMessage(error: unknown): string {
  if (isUniqueConstraintError(error)) {
    return "A workflow with this n8n ID is already registered for this organization. Use a different ID, or open the existing workflow below.";
  }
  return "Could not register the workflow. Check the values and try again.";
}

export function validateWorkflowRegistrationInput(input: {
  name: string;
  externalWorkflowId: string;
}): string | null {
  if (!input.name.trim()) {
    return "Workflow name is required.";
  }
  if (!input.externalWorkflowId.trim()) {
    return "n8n workflow ID is required. Copy it from the n8n URL: /workflow/{id}.";
  }
  return null;
}

export function contractDefinitionErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
  if (/not visible in tenant/i.test(message) || /Unknown workflow/i.test(message)) {
    return "Choose a registered workflow before saving the contract.";
  }
  return "Could not save the contract. Check the values and try again.";
}

export function validateContractDefinitionInput(input: {
  workflowId: string;
  name: string;
  businessPurpose: string;
  cadenceValue: string;
}): string | null {
  if (!input.workflowId.trim()) {
    return "Choose a registered workflow before saving the contract.";
  }
  if (!input.name.trim()) {
    return "Contract name is required.";
  }
  if (!input.businessPurpose.trim()) {
    return "Business purpose is required.";
  }
  if (!input.cadenceValue.trim()) {
    return "Cadence value is required (minutes, cron expression, or quiet window).";
  }
  return null;
}
