import dns from "node:dns/promises";
import {
  classifyIpAddress,
  isBlockedHostname,
} from "../../domain/connectors/network-policy.js";
import { sanitizeRemoteErrorMessage } from "../../domain/connectors/sanitize-remote-error.js";

export class SecureOutboundHttpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(sanitizeRemoteErrorMessage(message));
    this.name = "SecureOutboundHttpError";
    this.code = code;
  }
}

export type OutboundNetworkPolicy =
  /** Hosted / public connectors: HTTPS only, no private destinations. */
  | "public_https"
  /**
   * Self-hosted explicit local-network policy: HTTP or HTTPS allowed to
   * private/loopback/LAN hosts. Cloud metadata addresses stay blocked.
   */
  | "self_hosted_local";

export interface SecureOutboundHttpOptions {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  /** Defaults to public_https. */
  networkPolicy?: OutboundNetworkPolicy;
  /** Injected for tests. Defaults to dns.lookup of all addresses. */
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  /** Injected for tests. Defaults to global fetch with redirect:manual. */
  fetchImpl?: typeof fetch;
}

export interface SecureHttpResponse {
  status: number;
  headers: Headers;
  bodyText: string;
  finalUrl: string;
}

/**
 * Connector egress with DNS pre-check, redirect re-validation, timeouts, and
 * response size caps. Network policy selects public-HTTPS vs self-hosted local.
 */
export async function secureOutboundGet(
  targetUrl: string,
  headers: Record<string, string>,
  options: SecureOutboundHttpOptions,
): Promise<SecureHttpResponse> {
  const policy = options.networkPolicy ?? "public_https";
  const resolve =
    options.resolveAddresses ??
    (async (hostname: string) => {
      const results = await dns.lookup(hostname, { all: true, verbatim: true });
      return results.map((entry) => entry.address);
    });
  const fetchImpl = options.fetchImpl ?? fetch;

  let current =
    policy === "self_hosted_local"
      ? assertSelfHostedConnectorUrl(targetUrl)
      : assertPublicHttpsUrl(targetUrl);
  let redirects = 0;

  while (true) {
    if (policy === "public_https") {
      await assertHostnameResolvesPublic(current.hostname, resolve);
    } else {
      await assertHostnameResolvesSelfHosted(current.hostname, resolve);
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(options.connectTimeoutMs, options.readTimeoutMs),
    );

    let response: Response;
    try {
      response = await fetchImpl(current.toString(), {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      throw new SecureOutboundHttpError(
        "unreachable",
        error instanceof Error ? error.message : "connection_failed",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (isRedirectStatus(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        throw new SecureOutboundHttpError(
          "misconfigured",
          "redirect_missing_location",
        );
      }
      redirects += 1;
      if (redirects > options.maxRedirects) {
        throw new SecureOutboundHttpError(
          "misconfigured",
          "too_many_redirects",
        );
      }
      const next = new URL(location, current).toString();
      current =
        policy === "self_hosted_local"
          ? assertSelfHostedConnectorUrl(next)
          : assertPublicHttpsUrl(next);
      continue;
    }

    const bodyText = await readBodyLimited(response, options.maxResponseBytes);
    return {
      status: response.status,
      headers: response.headers,
      bodyText,
      finalUrl: current.toString(),
    };
  }
}

export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecureOutboundHttpError("misconfigured", "invalid_url");
  }

  if (url.protocol !== "https:") {
    throw new SecureOutboundHttpError(
      "misconfigured",
      "https_required_for_public_polling",
    );
  }
  if (url.username || url.password) {
    throw new SecureOutboundHttpError(
      "misconfigured",
      "url_userinfo_forbidden",
    );
  }
  if (isBlockedHostname(url.hostname)) {
    throw new SecureOutboundHttpError("misconfigured", "blocked_hostname");
  }
  return url;
}

/** Self-hosted n8n/connectors may use http(s) on LAN; metadata stays blocked. */
export function assertSelfHostedConnectorUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecureOutboundHttpError("misconfigured", "invalid_url");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SecureOutboundHttpError(
      "misconfigured",
      "http_or_https_required",
    );
  }
  if (url.username || url.password) {
    throw new SecureOutboundHttpError(
      "misconfigured",
      "url_userinfo_forbidden",
    );
  }
  if (isCloudMetadataHostname(url.hostname)) {
    throw new SecureOutboundHttpError("misconfigured", "blocked_hostname");
  }
  return url;
}

function isCloudMetadataHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (
    host === "metadata.google.internal" ||
    host === "metadata.goog" ||
    host === "169.254.169.254"
  ) {
    return true;
  }
  return false;
}

async function assertHostnameResolvesPublic(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<void> {
  if (isBlockedHostname(hostname)) {
    throw new SecureOutboundHttpError("misconfigured", "blocked_hostname");
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SecureOutboundHttpError("unreachable", "dns_resolution_failed");
  }
  if (addresses.length === 0) {
    throw new SecureOutboundHttpError("unreachable", "dns_empty");
  }
  for (const address of addresses) {
    const classified = classifyIpAddress(address);
    if (classified.blocked) {
      throw new SecureOutboundHttpError(
        "misconfigured",
        `blocked_resolved_address_${classified.reason}`,
      );
    }
  }
}

async function assertHostnameResolvesSelfHosted(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<void> {
  if (isCloudMetadataHostname(hostname)) {
    throw new SecureOutboundHttpError("misconfigured", "blocked_hostname");
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SecureOutboundHttpError("unreachable", "dns_resolution_failed");
  }
  if (addresses.length === 0) {
    throw new SecureOutboundHttpError("unreachable", "dns_empty");
  }
  for (const address of addresses) {
    if (address === "169.254.169.254") {
      throw new SecureOutboundHttpError(
        "misconfigured",
        "blocked_resolved_address_metadata",
      );
    }
  }
}

function isRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new SecureOutboundHttpError("misconfigured", "response_too_large");
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new SecureOutboundHttpError("misconfigured", "response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}
