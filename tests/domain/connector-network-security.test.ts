import { describe, expect, it } from "vitest";
import {
  classifyIpAddress,
  isBlockedHostname,
} from "../../src/domain/connectors/network-policy.js";
import {
  connectorErrorCodeFromHttpStatus,
  sanitizeRemoteErrorMessage,
} from "../../src/domain/connectors/sanitize-remote-error.js";
import {
  assertPublicHttpsUrl,
  assertSelfHostedConnectorUrl,
  SecureOutboundHttpError,
  secureOutboundGet,
} from "../../src/infrastructure/security/secure-outbound-http.js";

describe("connector network policy", () => {
  it("blocks loopback, private, link-local, and metadata ranges", () => {
    expect(classifyIpAddress("127.0.0.1")).toEqual({
      blocked: true,
      reason: "loopback",
    });
    expect(classifyIpAddress("10.0.0.5")).toEqual({
      blocked: true,
      reason: "private",
    });
    expect(classifyIpAddress("192.168.1.10")).toEqual({
      blocked: true,
      reason: "private",
    });
    expect(classifyIpAddress("172.16.4.1")).toEqual({
      blocked: true,
      reason: "private",
    });
    expect(classifyIpAddress("169.254.169.254")).toEqual({
      blocked: true,
      reason: "link_local",
    });
    expect(classifyIpAddress("::1")).toEqual({
      blocked: true,
      reason: "loopback",
    });
    expect(classifyIpAddress("8.8.8.8")).toEqual({ blocked: false });
  });

  it("blocks localhost and metadata hostnames", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("n8n.example.com")).toBe(false);
  });
});

describe("secure outbound HTTP", () => {
  const baseOptions = {
    connectTimeoutMs: 1_000,
    readTimeoutMs: 1_000,
    maxResponseBytes: 1_024,
    maxRedirects: 2,
  };

  it("requires HTTPS and rejects private literal URLs", () => {
    expect(() => assertPublicHttpsUrl("http://example.com")).toThrow(
      /https_required/,
    );
    expect(() => assertPublicHttpsUrl("https://127.0.0.1/api")).toThrow(
      SecureOutboundHttpError,
    );
    expect(() => assertPublicHttpsUrl("https://10.1.2.3/api")).toThrow(
      /blocked_hostname/,
    );
    expect(() =>
      assertPublicHttpsUrl("https://169.254.169.254/latest"),
    ).toThrow(SecureOutboundHttpError);
  });

  it("rejects DNS that resolves to private addresses (rebinding mitigation)", async () => {
    await expect(
      secureOutboundGet(
        "https://evil.example/api",
        {},
        {
          ...baseOptions,
          resolveAddresses: async () => ["10.0.0.8"],
          fetchImpl: async () => {
            throw new Error("should not fetch");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "misconfigured" });
  });

  it("rejects redirects that land on private destinations", async () => {
    let calls = 0;
    await expect(
      secureOutboundGet(
        "https://public.example/start",
        {},
        {
          ...baseOptions,
          resolveAddresses: async (hostname) => {
            if (hostname === "public.example") {
              return ["203.0.113.10"];
            }
            return ["127.0.0.1"];
          },
          fetchImpl: async () => {
            calls += 1;
            return new Response(null, {
              status: 302,
              headers: { location: "https://127.0.0.1/secret" },
            });
          },
        },
      ),
    ).rejects.toThrow(SecureOutboundHttpError);
    expect(calls).toBe(1);
  });

  it("caps response size and limits redirects", async () => {
    await expect(
      secureOutboundGet(
        "https://public.example/big",
        {},
        {
          ...baseOptions,
          maxResponseBytes: 8,
          resolveAddresses: async () => ["203.0.113.10"],
          fetchImpl: async () =>
            new Response("0123456789abcdef", {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("response_too_large"),
    });

    let hops = 0;
    await expect(
      secureOutboundGet(
        "https://public.example/r",
        {},
        {
          ...baseOptions,
          maxRedirects: 1,
          resolveAddresses: async () => ["203.0.113.10"],
          fetchImpl: async () => {
            hops += 1;
            return new Response(null, {
              status: 302,
              headers: { location: `https://public.example/r${hops}` },
            });
          },
        },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("too_many_redirects"),
    });
  });

  it("sanitizes remote errors and maps auth failures", () => {
    expect(
      sanitizeRemoteErrorMessage(
        "Authorization: Bearer SUPERSECRETTOKENVALUE123456 http failure",
      ),
    ).not.toContain("SUPERSECRET");
    expect(connectorErrorCodeFromHttpStatus(401)).toBe("auth_failed");
    expect(connectorErrorCodeFromHttpStatus(500)).toBe("upstream_error");
  });

  it("self_hosted_local allows private HTTP and still blocks cloud metadata", async () => {
    expect(() =>
      assertSelfHostedConnectorUrl("http://n8n:5678/api/v1/workflows"),
    ).not.toThrow();
    expect(() =>
      assertSelfHostedConnectorUrl("http://10.0.0.5:5678"),
    ).not.toThrow();
    expect(() =>
      assertSelfHostedConnectorUrl("http://169.254.169.254/latest"),
    ).toThrow(SecureOutboundHttpError);

    const response = await secureOutboundGet(
      "http://n8n.local/api/v1/workflows",
      { "X-N8N-API-KEY": "test" },
      {
        ...baseOptions,
        networkPolicy: "self_hosted_local",
        resolveAddresses: async () => ["10.0.0.20"],
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      },
    );
    expect(response.status).toBe(200);
  });
});
