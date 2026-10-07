/**
 * Stable error codes returned to MCP clients. Callers should branch on `code`,
 * never on `message`. See docs/s-kaupat-mcp-plan.md for the full list.
 */
export type ErrorCode =
  | "invalid_argument"
  | "store_not_selected"
  | "store_not_found"
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
    /** Short Finnish version of `message`, for apps that show errors to end users. */
    readonly messageFi?: string,
  ) {
    super(message);
    this.name = "SKaupatError";
  }
}

export function storeNotSelected(): SKaupatError {
  return new SKaupatError(
    "store_not_selected",
    "Choose your store first.",
    undefined,
    "Valitse ensin oma kauppasi.",
  );
}

export function storeNotFound(storeId: string): SKaupatError {
  return new SKaupatError(
    "store_not_found",
    "That store was not found. Choose your store again.",
    { storeId },
    "Kauppaa ei löytynyt. Valitse kauppa uudelleen.",
  );
}

export function toSKaupatError(err: unknown): SKaupatError {
  if (err instanceof SKaupatError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new SKaupatError("unavailable", "S-kaupat did not respond in time.");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SKaupatError("upstream_error", message);
}
