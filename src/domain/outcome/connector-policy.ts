import type {
  OutcomeConnectorStatus,
  OutcomeConnectorType,
  OutcomeConnectorProvider,
} from "./types.js";

export function isConnectorReadable(status: OutcomeConnectorStatus): boolean {
  return status === "active";
}

export function revokeConnectorStatus(): OutcomeConnectorStatus {
  return "disconnected";
}

export function unsupportedDimensionsForPath(input: {
  provider: OutcomeConnectorProvider;
  connectorType: OutcomeConnectorType;
  pathSupported: boolean;
}): string[] {
  if (!input.pathSupported) {
    return [
      "path_not_independently_verified",
      "destination_delivery_not_checked",
      "exact_record_matching_unavailable",
    ];
  }
  if (input.provider === "hubspot" && input.connectorType === "source") {
    return ["payload_count_supplied_by_workflow"];
  }
  if (input.provider === "zoom" && input.connectorType === "destination") {
    return ["payload_count_supplied_by_workflow"];
  }
  return ["path_not_independently_verified"];
}
