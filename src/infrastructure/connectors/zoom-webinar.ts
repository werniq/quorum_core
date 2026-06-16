import {
  secureOutboundGet,
  type SecureOutboundHttpOptions,
} from "../security/secure-outbound-http.js";
import type { ObservationRecord } from "../../domain/outcome/match-email.js";

export interface ZoomCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

async function fetchZoomAccessToken(
  credentials: ZoomCredentials,
  http: SecureOutboundHttpOptions,
): Promise<string> {
  const basic = Buffer.from(
    `${credentials.clientId}:${credentials.clientSecret}`,
  ).toString("base64");
  const url =
    `https://zoom.us/oauth/token?grant_type=account_credentials` +
    `&account_id=${encodeURIComponent(credentials.accountId)}`;

  const fetchImpl = http.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(http.connectTimeoutMs, http.readTimeoutMs),
  );
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`zoom_oauth_${response.status}`), {
        code: response.status === 401 ? "auth_failed" : "unreachable",
      });
    }
    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw Object.assign(new Error("zoom_oauth_missing_token"), {
        code: "auth_failed",
      });
    }
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lists Zoom webinar registrants for a window.
 * Collects only email + create time + registrant id.
 */
export async function fetchZoomWebinarRegistrants(input: {
  credentials: ZoomCredentials;
  webinarId: string;
  windowStart: Date;
  windowEnd: Date;
  http: SecureOutboundHttpOptions;
  accessToken?: string;
}): Promise<ObservationRecord[]> {
  const token =
    input.accessToken ??
    (await fetchZoomAccessToken(input.credentials, input.http));
  const url =
    `https://api.zoom.us/v2/webinars/${encodeURIComponent(input.webinarId)}/registrants` +
    `?page_size=100`;
  const response = await secureOutboundGet(
    url,
    {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
    input.http,
  );
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("zoom_auth_failed"), { code: "auth_failed" });
  }
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`zoom_http_${response.status}`), {
      code: "unreachable",
    });
  }

  const payload = JSON.parse(response.bodyText) as {
    registrants?: Array<{
      id?: string;
      email?: string;
      create_time?: string;
    }>;
  };

  const rows: ObservationRecord[] = [];
  for (const item of payload.registrants ?? []) {
    if (!item.email || !item.create_time) {
      continue;
    }
    const observedAt = new Date(item.create_time);
    if (
      Number.isNaN(observedAt.getTime()) ||
      observedAt < input.windowStart ||
      observedAt > input.windowEnd
    ) {
      continue;
    }
    rows.push({
      providerRecordId: item.id ?? null,
      email: item.email,
      observedAt,
    });
  }
  return rows;
}

export async function probeZoomHealth(input: {
  credentials: ZoomCredentials;
  http: SecureOutboundHttpOptions;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await fetchZoomAccessToken(input.credentials, input.http);
    return { ok: true };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: string }).code)
        : "unreachable";
    return {
      ok: false,
      code,
      message: error instanceof Error ? error.message : "zoom_probe_failed",
    };
  }
}
