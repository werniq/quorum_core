export type AgencyRole = "admin" | "operator" | "viewer";

export type AgencyCapability =
  | "team"
  | "clients"
  | "contracts"
  | "connectors"
  | "reports"
  | "channels"
  | "incidents"
  | "read_catalog";

const ROLE_CAPS: Record<AgencyRole, ReadonlySet<AgencyCapability>> = {
  admin: new Set([
    "team",
    "clients",
    "contracts",
    "connectors",
    "reports",
    "channels",
    "incidents",
    "read_catalog",
  ]),
  operator: new Set([
    "clients",
    "contracts",
    "connectors",
    "reports",
    "channels",
    "incidents",
    "read_catalog",
  ]),
  viewer: new Set(["read_catalog", "reports", "incidents"]),
};

export function roleHasCapability(
  role: AgencyRole,
  capability: AgencyCapability,
): boolean {
  return ROLE_CAPS[role].has(capability);
}

export function canMutateOps(role: AgencyRole): boolean {
  return role === "admin" || role === "operator";
}

export function parseAgencyRole(
  value: string | null | undefined,
): AgencyRole | null {
  if (value === "admin" || value === "operator" || value === "viewer") {
    return value;
  }
  return null;
}
