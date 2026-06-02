import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Dashboard security headers — no remote CDNs; CSP is local-only.
 */
export function applySecurityHeaders(
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()",
  );
  reply.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  // HSTS only meaningful behind HTTPS terminators; set when secure.
  if (
    typeof _request.headers["x-forwarded-proto"] === "string" &&
    _request.headers["x-forwarded-proto"] === "https"
  ) {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}
