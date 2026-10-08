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
  | "login_in_progress"
  | "browser_unavailable"
  | "browser_busy"
  | "store_not_selected"
  | "store_not_found"
  | "product_unavailable"
  | "list_not_found"
  | "delivery_area_not_found"
  | "slot_unavailable"
  | "blocked"
  | "invalid_quantity"
  | "context_changed"
  | "unavailable"
  | "conflict"
  | "unsupported"
  | "write_uncertain"
  | "order_not_ready"
  | "confirmation_required"
  | "ordering_not_possible"
  | "reservation_expired"
  | "unpaid_orders"
  | "payment_failed"
  | "order_not_found"
  | "order_uncertain"
  | "orders_disabled"
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
  login_in_progress: {
    fi: "Kirjautuminen on kesken. Kirjaudu ensin loppuun ja yritä sitten uudelleen.",
    en: "Login is in progress. Finish logging in, then try again.",
  },
  browser_unavailable: {
    fi: "S-kaupat tarvitsee Microsoft Edge- tai Google Chrome -selaimen, eikä sitä voitu avata.",
    en: "S-kaupat needs Microsoft Edge or Google Chrome, and it could not be opened.",
  },
  browser_busy: {
    fi: "S-kaupat on jo käytössä toisessa sovelluksessa. Yritä hetken päästä uudelleen.",
    en: "S-kaupat is in use in another app. Please try again in a moment.",
  },
  store_not_selected: { fi: "Valitse ensin kauppa.", en: "Please choose a store first." },
  store_not_found: {
    fi: "Kauppaa ei löytynyt. Valitse kauppa uudelleen.",
    en: "That store could not be found. Please choose your store again.",
  },
  product_unavailable: {
    fi: "Tuotetta ei ole saatavilla tässä kaupassa.",
    en: "This product is not available in this store.",
  },
  list_not_found: {
    fi: "Ostoslistaa ei löytynyt. Se on ehkä poistettu.",
    en: "That shopping list could not be found. It may have been deleted.",
  },
  delivery_area_not_found: {
    fi: "Toimitustapaa ei löytynyt. Valitse toimitustapa uudelleen.",
    en: "That delivery option could not be found. Please choose how to get your order again.",
  },
  slot_unavailable: {
    fi: "Valittu aika ei ole enää vapaana. Valitse toinen aika.",
    en: "That time is no longer available. Please choose another time.",
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
  order_not_ready: {
    fi: "Tilauksesta puuttuu vielä tietoja. Täydennä ne ja yritä uudelleen.",
    en: "Some order details are still missing. Please fill them in and try again.",
  },
  confirmation_required: {
    fi: "Tilaus muuttui yhteenvedon jälkeen. Tarkista yhteenveto ja vahvista uudelleen.",
    en: "The order changed after the summary. Please check the summary and confirm again.",
  },
  ordering_not_possible: {
    fi: "Tilausta ei voi tehdä näillä tuotteilla tälle ajalle. Tarkista tuotteet.",
    en: "This order can't be placed for that time with these products. Please check the products.",
  },
  reservation_expired: {
    fi: "Toimitusajan varaus vanheni. Valitse aika uudelleen.",
    en: "The time reservation expired. Please choose the time again.",
  },
  unpaid_orders: {
    fi: "Tililläsi on maksamaton tilaus. Maksa se ensin, niin voit tilata uudelleen.",
    en: "Your account has an unpaid order. Please pay it first, then you can order again.",
  },
  payment_failed: {
    fi: "Maksu ei onnistunut. Yritä uudelleen tai valitse toinen maksutapa.",
    en: "The payment did not go through. Please try again or choose another payment method.",
  },
  order_not_found: {
    fi: "Tilausta ei löytynyt.",
    en: "That order could not be found.",
  },
  order_uncertain: {
    fi: "Tilauksen onnistumista ei voitu varmistaa. Tarkista tilaukset ennen kuin yrität uudelleen.",
    en: "We could not confirm whether the order went through. Please check your orders before trying again.",
  },
  orders_disabled: {
    fi: "Tilaaminen on poistettu käytöstä tässä sovelluksessa.",
    en: "Ordering is turned off in this app.",
  },
  upstream_error: {
    fi: "S-kaupassa tapahtui virhe. Yritä uudelleen.",
    en: "Something went wrong at S-kaupat. Please try again.",
  },
};

/**
 * What the app should offer the user next, so it can pick the right button
 * without a table of codes:
 * - log_in: show the "Log in" button (start_login).
 * - finish_login: the login window is open; wait for the user, then retry.
 * - choose_store: show the store picker (search_stores, select_store).
 * - retry: try again shortly; nothing for the user to fix.
 * - check_list: show the list again (get_shopping_list) so the user sees what is on it.
 * - refresh_lists: the list is gone; show the lists again (get_shopping_lists).
 * - choose_delivery: show the delivery and pickup options again (get_delivery_options).
 * - choose_delivery_time: show the times again (get_delivery_slots) so the user picks another.
 * - choose_other_product: offer another product.
 * - install_browser: the PC needs Microsoft Edge or Google Chrome.
 * - review_order: show the order summary again (review_order) and let the user confirm it.
 * - pay: show the payment step again (pay_order), or another payment method.
 * - check_orders: show the user's orders (get_order) before doing anything else.
 * - none: nothing the user can do now (a bug in the request, or a missing feature).
 */
export type ErrorAction =
  | "log_in"
  | "finish_login"
  | "choose_store"
  | "choose_delivery"
  | "choose_delivery_time"
  | "retry"
  | "check_list"
  | "refresh_lists"
  | "choose_other_product"
  | "install_browser"
  | "review_order"
  | "pay"
  | "check_orders"
  | "none";

export const ERROR_ACTIONS: Record<ErrorCode, { action: ErrorAction; retryable: boolean }> = {
  invalid_argument: { action: "none", retryable: false },
  login_required: { action: "log_in", retryable: false },
  session_expired: { action: "log_in", retryable: false },
  login_window_unavailable: { action: "install_browser", retryable: false },
  login_in_progress: { action: "finish_login", retryable: true },
  browser_unavailable: { action: "install_browser", retryable: false },
  browser_busy: { action: "retry", retryable: true },
  store_not_selected: { action: "choose_store", retryable: false },
  store_not_found: { action: "choose_store", retryable: false },
  product_unavailable: { action: "choose_other_product", retryable: false },
  list_not_found: { action: "refresh_lists", retryable: false },
  delivery_area_not_found: { action: "choose_delivery", retryable: false },
  slot_unavailable: { action: "choose_delivery_time", retryable: false },
  blocked: { action: "retry", retryable: true },
  invalid_quantity: { action: "none", retryable: false },
  context_changed: { action: "retry", retryable: true },
  unavailable: { action: "retry", retryable: true },
  conflict: { action: "retry", retryable: true },
  unsupported: { action: "none", retryable: false },
  write_uncertain: { action: "check_list", retryable: false },
  order_not_ready: { action: "review_order", retryable: false },
  confirmation_required: { action: "review_order", retryable: false },
  ordering_not_possible: { action: "check_list", retryable: false },
  reservation_expired: { action: "choose_delivery_time", retryable: false },
  unpaid_orders: { action: "check_orders", retryable: false },
  payment_failed: { action: "pay", retryable: true },
  order_not_found: { action: "check_orders", retryable: false },
  order_uncertain: { action: "check_orders", retryable: false },
  orders_disabled: { action: "none", retryable: false },
  upstream_error: { action: "retry", retryable: true },
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

export function storeNotSelected(): SKaupatError {
  return new SKaupatError("store_not_selected", "No store given and none selected with select_store.");
}

export function storeNotFound(storeId: string): SKaupatError {
  return new SKaupatError("store_not_found", `Store ${storeId} was not found.`, { storeId });
}

export function listNotFound(listId: string): SKaupatError {
  return new SKaupatError("list_not_found", `Shopping list ${listId} was not found.`, { listId });
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
