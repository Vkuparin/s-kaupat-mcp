/**
 * Stable error codes returned to MCP clients. Callers should branch on `code`,
 * never on `message`. Each code has a short Finnish and English message in
 * USER_MESSAGES that a caller app can show to the user as-is.
 */
export type ErrorCode =
  | "invalid_argument"
  | "login_required"
  | "session_expired"
  | "login_window_unavailable"
  | "store_not_selected"
  | "store_not_found"
  | "product_unavailable"
  | "blocked"
  | "invalid_quantity"
  | "context_changed"
  | "unavailable"
  | "conflict"
  | "unsupported"
  | "write_uncertain"
  | "upstream_error";

export interface UserMessage {
  fi: string;
  en: string;
}

/** One entry per code, so every error the server returns has user-facing text. */
export const USER_MESSAGES: Record<ErrorCode, UserMessage> = {
  invalid_argument: { fi: "Pyyntö oli virheellinen.", en: "The request was invalid." },
  login_required: {
    fi: "Kirjaudu ensin S-kaupat-tilillesi.",
    en: "Please log in to your S-kaupat account first.",
  },
  session_expired: {
    fi: "Istunto on vanhentunut. Kirjaudu uudelleen.",
    en: "Your session has expired. Please log in again.",
  },
  login_window_unavailable: {
    fi: "Kirjautumisikkunaa ei voitu avata tällä laitteella.",
    en: "The login window could not be opened on this device.",
  },
  store_not_selected: { fi: "Valitse ensin kauppa.", en: "Please choose a store first." },
  store_not_found: { fi: "Kauppaa ei löytynyt.", en: "That store could not be found." },
  product_unavailable: {
    fi: "Tuotetta ei ole saatavilla tässä kaupassa.",
    en: "This product is not available in this store.",
  },
  blocked: {
    fi: "S-kaupat esti pyynnön. Yritä hetken päästä uudelleen.",
    en: "S-kaupat refused the request. Please try again in a moment.",
  },
  invalid_quantity: { fi: "Määrä ei kelpaa.", en: "That quantity is not valid." },
  context_changed: {
    fi: "Kaupan tiedot muuttuivat. Päivitä ja yritä uudelleen.",
    en: "The store details changed. Please refresh and try again.",
  },
  unavailable: {
    fi: "S-kaupat ei juuri nyt vastaa. Yritä hetken päästä uudelleen.",
    en: "S-kaupat is not responding right now. Please try again shortly.",
  },
  conflict: {
    fi: "Tiedot muuttuivat samaan aikaan toisaalla. Yritä uudelleen.",
    en: "Something changed elsewhere at the same time. Please try again.",
  },
  unsupported: { fi: "Tätä toimintoa ei voi vielä käyttää.", en: "This feature is not available yet." },
  write_uncertain: {
    fi: "Muutoksen onnistumista ei voitu varmistaa. Tarkista tilanne S-kaupat-sivulta.",
    en: "We could not confirm the change went through. Please check on the S-kaupat site.",
  },
  upstream_error: {
    fi: "S-kaupassa tapahtui virhe. Yritä uudelleen.",
    en: "Something went wrong at S-kaupat. Please try again.",
  },
};

export class SKaupatError extends Error {
  constructor(
    readonly code: ErrorCode,
    /** Technical detail for logs and developers; not meant for end users. */
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SKaupatError";
  }

  get userMessage(): UserMessage {
    return USER_MESSAGES[this.code];
  }
}

export function toSKaupatError(err: unknown): SKaupatError {
  if (err instanceof SKaupatError) return err;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new SKaupatError("unavailable", "S-kaupat did not respond in time.");
  }
  if (err instanceof TypeError && err.message === "fetch failed") {
    return new SKaupatError("unavailable", "Could not reach S-kaupat.");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SKaupatError("upstream_error", message);
}

/** S-kaupat's GraphQL error names that mean "this product can't be had here". */
const PRODUCT_UNAVAILABLE_ERRORS = ["ProductNotFoundError", "ProductNotInAssortmentError", "ProductAvailabilityError"];

/** True when a GraphQL error's code or message names one of the product errors. */
export function isProductUnavailableError(error: { message?: string; extensions?: { code?: string } }): boolean {
  const text = `${error.extensions?.code ?? ""} ${error.message ?? ""}`;
  return PRODUCT_UNAVAILABLE_ERRORS.some((name) => text.includes(name));
}
