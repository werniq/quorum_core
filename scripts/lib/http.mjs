/**
 * Shared HTTP helpers for self-hosted verification scripts (Node.js, Windows-first).
 */

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 */
export async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 15_000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Headers | string | null | undefined} setCookie
 * @param {string} [name]
 */
export function extractCookie(setCookie, name = "quorum_session") {
  const raw =
    typeof setCookie === "string"
      ? setCookie
      : (setCookie?.get?.("set-cookie") ??
        (Array.isArray(setCookie) ? setCookie.join(",") : ""));
  if (!raw) {
    return null;
  }
  const parts = String(raw).split(/,(?=\s*[^;=]+=)/);
  for (const part of parts) {
    const match = part.match(new RegExp(`(?:^|[\\s,])${name}=([^;]+)`));
    if (match) {
      return decodeURIComponent(match[1].trim());
    }
  }
  // Fallback: single Set-Cookie style
  const simple = String(raw).match(new RegExp(`${name}=([^;]+)`));
  return simple ? decodeURIComponent(simple[1].trim()) : null;
}

/**
 * Parse hidden input name=csrf from HTML.
 * @param {string} html
 */
export function parseCsrfFromHtml(html) {
  const match =
    html.match(
      /<input[^>]*name=["']csrf["'][^>]*value=["']([^"']+)["'][^>]*>/i,
    ) ??
    html.match(
      /<input[^>]*value=["']([^"']+)["'][^>]*name=["']csrf["'][^>]*>/i,
    );
  return match?.[1] ?? null;
}

/**
 * @param {string} url
 * @param {Record<string, string>} fields
 * @param {{ cookie?: string | null; timeoutMs?: number; redirect?: RequestRedirect }} [options]
 */
export async function formPost(url, fields, options = {}) {
  const body = new URLSearchParams(fields).toString();
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "text/html,application/xhtml+xml",
  };
  if (options.cookie) {
    headers.cookie = options.cookie.includes("=")
      ? options.cookie
      : `quorum_session=${options.cookie}`;
  }
  return fetchWithTimeout(url, {
    method: "POST",
    headers,
    body,
    redirect: options.redirect ?? "manual",
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

/**
 * @param {string} url
 * @param {{ okStatuses?: number[]; timeoutMs?: number; intervalMs?: number; label?: string }} [options]
 */
export async function waitForUrl(url, options = {}) {
  const okStatuses = options.okStatuses ?? [200];
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const label = options.label ?? url;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        timeoutMs: Math.min(10_000, intervalMs * 4),
      });
      lastStatus = response.status;
      if (okStatuses.includes(response.status)) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : lastStatus != null
        ? `last status ${lastStatus}`
        : "no response";
  throw new Error(`waitForUrl timed out for ${label}: ${detail}`);
}

/**
 * n8n exposes /healthz before migrations finish; /rest then returns
 * "n8n is starting up" or Express HTML 404. Wait until /rest/settings is real JSON.
 * @param {string} n8nBase
 * @param {{ timeoutMs?: number }} [options]
 */
export async function waitForN8nRestReady(n8nBase, options = {}) {
  const root = n8nBase.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetchWithTimeout(`${root}/rest/settings`, {
        method: "GET",
        timeoutMs: 10_000,
      });
      const text = await response.text();
      lastDetail = `status ${response.status}: ${text.slice(0, 120)}`;
      if (
        response.status === 200 &&
        !/starting up/i.test(text) &&
        (text.trim().startsWith("{") || text.trim().startsWith("["))
      ) {
        return response;
      }
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`waitForN8nRestReady timed out for ${root}: ${lastDetail}`);
}
