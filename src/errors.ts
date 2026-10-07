/**
 * Stable error codes returned to MCP clients. Callers should branch on `code`,
 * never on `message`. See docs/s-kaupat-mcp-plan.md for the full list.
 */
export type ErrorCode =
  | "invalid_argument"
  | "auth_required"
  | "session_expired"
  | "blocked"
  | "invalid_quantity"
  | "context_changed"
  | "unavailable"
  | "conflict"
  | "unsupported"
  | "write_uncertain"
  | "upstream_error";

export class SKaupatError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SKaupatError";
  }
}

export function toSKaupatError(err: unknown): SKaupatError {
  if (err instanceof SKaupatError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new SKaupatError("unavailable", "S-kaupat did not respond in time.");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SKaupatError("upstream_error", message);
}
