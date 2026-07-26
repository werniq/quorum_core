import type { IncidentListCursor } from "../../application/repositories/alerting-repositories.js";

const PREFIX = "v1.";

/**
 * Opaque cursor for GET /api/v1/incidents (base64url JSON).
 * Consumers must treat the string as opaque.
 */
export function encodeIncidentListCursor(cursor: IncidentListCursor): string {
  const payload = Buffer.from(
    JSON.stringify({ u: cursor.updatedAt, i: cursor.id }),
    "utf8",
  ).toString("base64url");
  return `${PREFIX}${payload}`;
}

export function decodeIncidentListCursor(
  raw: string,
): IncidentListCursor | null {
  if (!raw.startsWith(PREFIX)) {
    return null;
  }
  try {
    const json = Buffer.from(raw.slice(PREFIX.length), "base64url").toString(
      "utf8",
    );
    const parsed = JSON.parse(json) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string") {
      return null;
    }
    if (parsed.u.length === 0 || parsed.i.length === 0) {
      return null;
    }
    return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    return null;
  }
}
