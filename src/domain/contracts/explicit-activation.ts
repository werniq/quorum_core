/**
 * Contracts must be user-confirmed. Metadata import may suggest values,
 * but activation/alteration without explicit confirmation is forbidden.
 */
export function assertExplicitContractConfirmation(
  explicitlyConfirmed: boolean,
  action: "activate" | "alter",
): void {
  if (!explicitlyConfirmed) {
    throw new Error(
      `Refusing to ${action} contract without explicit user confirmation.`,
    );
  }
}
