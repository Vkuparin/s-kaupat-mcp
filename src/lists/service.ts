import type { BasketCheck, ListableProduct, SKaupatClient } from "../client/types.js";
import { type ErrorCode, SKaupatError, toSKaupatError, USER_MESSAGES, type UserMessage } from "../errors.js";
import { log } from "../log.js";
import type { ShoppingList, ShoppingListApi, ShoppingListItem } from "./types.js";

/** Runs an authenticated call with a valid access token (renewing once if S-kaupat rejects it). */
export type WithToken = <T>(fn: (accessToken: string) => Promise<T>) => Promise<T>;

export interface RequestedItem {
  productId: string;
  quantity: number;
  allowSubstitutes: boolean;
}

/** Why a product was not put on the list. */
export type MissingReason = "unknown_barcode" | "not_sold_in_store" | "no_internal_id" | "write_failed";

export interface ItemError {
  code: ErrorCode;
  reason?: MissingReason;
  userMessage: UserMessage;
  /** S-kaupat's own short label, in Finnish, when it gave one. */
  label?: string | null;
}

/**
 * What happened to one requested product:
 * - added: newly on the list.
 * - updated: was already on the list; now has the requested quantity and substitute choice.
 * - unchanged: was already on the list exactly as requested.
 * - missing: not written (see error).
 * - uncertain: the write may or may not have gone through; check the list.
 */
export type ItemOutcome =
  | {
      productId: string;
      status: "added" | "updated" | "unchanged";
      requestedQuantity: number;
      item: ShoppingListItem;
      /** Set when the product is on the list but S-kaupat says it can't be ordered right now. */
      warning?: ItemError;
    }
  | { productId: string; status: "missing" | "uncertain"; requestedQuantity: number; name: string | null; error: ItemError };

export interface ListWriteResult {
  list: ShoppingList;
  results: ItemOutcome[];
}

/**
 * Puts products on a shopping list and reports, per product, what actually
 * happened. Products are resolved to S-kaupat's list input (EAN, sokId,
 * name) in one lookup and checked with S-kaupat's cart check first, so
 * products the store doesn't sell are reported as missing instead of written.
 */
export async function addItemsToList(options: {
  client: SKaupatClient;
  lists: ShoppingListApi;
  withToken: WithToken;
  storeId: string;
  list: ShoppingList;
  items: RequestedItem[];
}): Promise<ListWriteResult> {
  const { client, lists, withToken, storeId } = options;
  let list = options.list;
  const items = mergeDuplicates(options.items);
  if (items.length === 0) return { list, results: [] };

  const ids = items.map((i) => i.productId);
  const listable = await client.getListableProducts(storeId, ids);
  const checks = await tryCheckBasket(client, storeId, items);

  const results: ItemOutcome[] = [];
  let stop: SKaupatError | null = null;

  for (const req of items) {
    const base = { productId: req.productId, requestedQuantity: req.quantity };
    const found = listable.get(req.productId);
    const check = checks.get(req.productId);
    if (stop) {
      results.push({ ...base, status: "missing", name: found?.product.name ?? null, error: itemError(stop.code, "write_failed") });
      continue;
    }
    const problem = productProblem(found, check);
    if (problem || !found) {
      results.push({ ...base, status: "missing", name: found?.product.name ?? null, error: problem! });
      continue;
    }

    const existing = list.items.find((i) => i.productId === req.productId);
    if (existing && existing.quantity === req.quantity && existing.allowSubstitutes === req.allowSubstitutes) {
      results.push({ ...base, status: "unchanged", item: existing, ...warningFor(check) });
      continue;
    }

    try {
      // S-kaupat's item update input is not mapped yet, so a change is a remove and a re-add.
      if (existing) list = await withToken((t) => lists.removeItem(t, list.id, existing.itemId, storeId));
      list = await withToken((t) =>
        lists.addItem(
          t,
          list.id,
          {
            ean: req.productId,
            sokId: found.sokId!,
            name: found.product.name,
            quantity: req.quantity,
            isReplaceable: req.allowSubstitutes,
          },
          storeId,
        ),
      );
      const written = list.items.find((i) => i.productId === req.productId);
      if (written) {
        results.push({ ...base, status: existing ? "updated" : "added", item: written, ...warningFor(check) });
      } else {
        results.push({ ...base, status: "uncertain", name: found.product.name, error: itemError("write_uncertain") });
      }
    } catch (err) {
      const e = toSKaupatError(err);
      log.warn("Shopping list write failed", { code: e.code, productId: req.productId });
      if (e.code === "login_required" || e.code === "session_expired" || e.code === "list_not_found") {
        // Nothing more can be written; report this and the rest as missing with the reason.
        if (results.length === 0) throw e;
        stop = e;
        results.push({ ...base, status: "missing", name: found.product.name, error: itemError(e.code, "write_failed") });
      } else {
        // A timeout or server error mid-write may still have saved the item; re-read the list below.
        results.push({ ...base, status: "uncertain", name: found.product.name, error: itemError("write_uncertain") });
      }
    }
  }

  if (results.some((r) => r.status === "uncertain")) {
    const fresh = await withToken((t) => lists.getList(t, list.id, storeId)).catch(() => null);
    if (fresh) {
      list = fresh;
      for (const [i, r] of results.entries()) {
        const item = r.status === "uncertain" ? fresh.items.find((x) => x.productId === r.productId) : undefined;
        if (item) results[i] = { productId: r.productId, requestedQuantity: r.requestedQuantity, status: "added", item };
      }
    }
  }
  return { list, results };
}

function mergeDuplicates(items: RequestedItem[]): RequestedItem[] {
  const merged = new Map<string, RequestedItem>();
  for (const item of items) {
    const prev = merged.get(item.productId);
    merged.set(item.productId, prev ? { ...item, quantity: prev.quantity + item.quantity } : { ...item });
  }
  return [...merged.values()];
}

async function tryCheckBasket(
  client: SKaupatClient,
  storeId: string,
  items: RequestedItem[],
): Promise<Map<string, BasketCheck>> {
  try {
    return await client.checkBasket(storeId, items.map((i) => ({ id: i.productId, quantity: i.quantity })));
  } catch (err) {
    // The check only adds warnings; writing the list must not depend on it.
    log.warn("Cart check failed; writing the list without it", { code: toSKaupatError(err).code });
    return new Map();
  }
}

function productProblem(found: ListableProduct | undefined, check: BasketCheck | undefined): ItemError | null {
  if (check?.status === "not_found") return itemError("product_unavailable", "unknown_barcode", check.label);
  if (check?.status === "not_in_store") return itemError("product_unavailable", "not_sold_in_store", check.label);
  if (!found) return itemError("product_unavailable", "not_sold_in_store");
  if (!found.sokId) return itemError("product_unavailable", "no_internal_id");
  return null;
}

function warningFor(check: BasketCheck | undefined): { warning?: ItemError } {
  return check?.status === "unavailable" ? { warning: itemError("product_unavailable", undefined, check.label) } : {};
}

function itemError(code: ErrorCode, reason?: MissingReason, label?: string | null): ItemError {
  return { code, ...(reason ? { reason } : {}), userMessage: USER_MESSAGES[code], ...(label ? { label } : {}) };
}
