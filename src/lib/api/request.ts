/**
 * Request helpers — IP extraction and request introspection.
 */

/**
 * Extract the client IP from the `x-forwarded-for` header (first hop).
 */
export function getClientIP(req: Request): string | undefined {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() ?? undefined;
}
