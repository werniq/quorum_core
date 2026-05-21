/**
 * Classifies IPv4/IPv6 literals that must not be used as hosted public poll targets.
 * Hosted Quorum must not reach private, loopback, link-local, or cloud metadata ranges.
 */

export type BlockedAddressReason =
  | "loopback"
  | "private"
  | "link_local"
  | "unspecified"
  | "metadata"
  | "invalid";

export function classifyIpAddress(
  address: string,
): { blocked: false } | { blocked: true; reason: BlockedAddressReason } {
  const normalized = address.trim().toLowerCase();
  if (!normalized) {
    return { blocked: true, reason: "invalid" };
  }

  if (normalized.includes(":")) {
    return classifyIpv6(normalized);
  }
  return classifyIpv4(normalized);
}

function classifyIpv4(
  address: string,
): { blocked: false } | { blocked: true; reason: BlockedAddressReason } {
  const parts = address.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return { blocked: true, reason: "invalid" };
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) {
    return { blocked: true, reason: "unspecified" };
  }
  if (a === 127) {
    return { blocked: true, reason: "loopback" };
  }
  if (a === 10) {
    return { blocked: true, reason: "private" };
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return { blocked: true, reason: "private" };
  }
  if (a === 192 && b === 168) {
    return { blocked: true, reason: "private" };
  }
  if (a === 169 && b === 254) {
    return { blocked: true, reason: "link_local" };
  }
  // AWS/GCP/Azure metadata commonly 169.254.169.254 (already link_local).
  if (a === 100 && b >= 64 && b <= 127) {
    // Carrier-grade NAT — treat as non-public for hosted egress.
    return { blocked: true, reason: "private" };
  }
  return { blocked: false };
}

function classifyIpv6(
  address: string,
): { blocked: false } | { blocked: true; reason: BlockedAddressReason } {
  if (address === "::" || address === "0:0:0:0:0:0:0:0") {
    return { blocked: true, reason: "unspecified" };
  }
  if (
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("::ffff:127.")
  ) {
    return { blocked: true, reason: "loopback" };
  }
  if (address.startsWith("fe80:")) {
    return { blocked: true, reason: "link_local" };
  }
  if (
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fc00:") ||
    address.startsWith("fd00:")
  ) {
    return { blocked: true, reason: "private" };
  }
  // IPv4-mapped private addresses.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) {
    return classifyIpv4(mapped[1]!);
  }
  return { blocked: false };
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }
  if (host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  // Only treat IP literals as addresses; DNS names are validated after resolution.
  if (looksLikeIpLiteral(host)) {
    return classifyIpAddress(host).blocked;
  }
  return false;
}

function looksLikeIpLiteral(value: string): boolean {
  if (value.includes(":")) {
    return true;
  }
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}
