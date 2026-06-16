import {
  secureOutboundGet,
  type SecureOutboundHttpOptions,
} from "../security/secure-outbound-http.js";
import type { ObservationRecord } from "../../domain/outcome/match-email.js";

export interface HubSpotCredentials {
  accessToken: string;
}

/**
 * Lists HubSpot marketing-event attendees (webinar registrations) for a window.
 * Collects only email + registration time + provider id — no full contact payloads.
 */
export async function fetchHubSpotWebinarRegistrations(input: {
  credentials: HubSpotCredentials;
  marketingEventId: string;
  windowStart: Date;
  windowEnd: Date;
  http: SecureOutboundHttpOptions;
}): Promise<ObservationRecord[]> {
  const url =
    `https://api.hubapi.com/marketing/v3/marketing-events/events/` +
    `${encodeURIComponent(input.marketingEventId)}/attendance/registrations` +
    `?limit=100`;
  const response = await secureOutboundGet(
    url,
    {
      authorization: `Bearer ${input.credentials.accessToken}`,
      accept: "application/json",
    },
    input.http,
  );
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("hubspot_auth_failed"), {
      code: "auth_failed",
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw Object.assign(new Error(`hubspot_http_${response.status}`), {
      code: "unreachable",
    });
  }

  const payload = JSON.parse(response.bodyText) as {
    results?: Array<{
      id?: string;
      contactId?: string;
      properties?: { email?: string; registeredAt?: string };
      email?: string;
      registeredAt?: string;
    }>;
  };

  const rows: ObservationRecord[] = [];
  for (const item of payload.results ?? []) {
    const email = item.email ?? item.properties?.email ?? null;
    const registeredAtRaw =
      item.registeredAt ?? item.properties?.registeredAt ?? null;
    if (!email || !registeredAtRaw) {
      continue;
    }
    const observedAt = new Date(registeredAtRaw);
    if (
      Number.isNaN(observedAt.getTime()) ||
      observedAt < input.windowStart ||
      observedAt > input.windowEnd
    ) {
      continue;
    }
    rows.push({
      providerRecordId: item.id ?? item.contactId ?? null,
      email,
      observedAt,
    });
  }
  return rows;
}

export async function probeHubSpotHealth(input: {
  credentials: HubSpotCredentials;
  http: SecureOutboundHttpOptions;
}): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    const response = await secureOutboundGet(
      "https://api.hubapi.com/integrations/v1/me",
      {
        authorization: `Bearer ${input.credentials.accessToken}`,
        accept: "application/json",
      },
      input.http,
    );
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: "auth_failed",
        message: "hubspot_unauthorized",
      };
    }
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        code: "unreachable",
        message: `hubspot_http_${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "unreachable",
      message: error instanceof Error ? error.message : "hubspot_probe_failed",
    };
  }
}
