import type { BasketCheck, BasketDelivery, ListableProduct, SKaupatClient } from "../client/types.js";
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
export type MissingReason = "unknown_barcode" | "not_sold_in_store" | "no_internal_id" | "write_failed" | "whole_pieces_only" | "too_many";

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
  /** The list was created for this call: report a failed first write per item instead of throwing, so the caller still gets the new list. */
  newList?: boolean;
  /** The chosen pickup or delivery time, so out-of-stock warnings are for that day. */
  delivery?: BasketDelivery;
}): Promise<ListWriteResult> {
  const { client, lists, withToken, storeId } = options;
  let list = options.list;
  const items = mergeDuplicates(options.items);
  if (items.length === 0) return { list, results: [] };

  const ids = items.map((i) => i.productId);
  const listable = await client.getListableProducts(storeId, ids);
  const checks = await tryCheckBasket(client, storeId, items, options.delivery);

  const results: ItemOutcome[] = [];
  const wasOnList = new Set(list.items.map((i) => i.productId));
  let stop: SKaupatError | null = null;

  for (const req of items) {
    const base = { productId: req.productId, requestedQuantity: req.quantity };
    const found = listable.get(req.productId);
    const check = checks.get(req.productId);
    if (stop) {
      results.push({ ...base, status: "missing", name: found?.product.name ?? null, error: itemError(stop.code, "write_failed") });
      continue;
    }
    const problem = productProblem(found, check) ?? quantityProblem(found, req.quantity);
    if (problem || !found) {
      results.push({ ...base, status: "missing", name: found?.product.name ?? null, error: problem! });
      continue;
    }

    // The product may already be on the list more than once (added on the site, or an earlier
    // half-finished change): every old row goes, so exactly one row with the request is left.
    const oldRows = list.items.filter((i) => i.productId === req.productId);
    const existing = oldRows[0];
    if (oldRows.length === 1 && matches(existing!, req)) {
      results.push({ ...base, status: "unchanged", item: existing!, ...warningFor(check) });
      continue;
    }
    const oldIds = new Set(oldRows.map((r) => r.itemId));

    try {
      // S-kaupat's item update input is not mapped yet, so a change is an add followed by removing
      // the old row. Adding first means a failure never leaves the product off the list.
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
      if (list.items.some((i) => i.productId === req.productId && !oldIds.has(i.itemId))) {
        for (const old of oldRows) list = await withToken((t) => lists.removeItem(t, list.id, old.itemId, storeId));
      }
      const rows = list.items.filter((i) => i.productId === req.productId);
      const written = rows.length === 1 ? rows[0] : undefined;
      if (written && matches(written, req)) {
        results.push({ ...base, status: existing ? "updated" : "added", item: written, ...warningFor(check) });
      } else {
        results.push({ ...base, status: "uncertain", name: found.product.name, error: itemError("write_uncertain") });
      }
    } catch (err) {
      const e = toSKaupatError(err);
      log.warn("Shopping list write failed", { code: e.code, productId: req.productId });
      if (e.code === "login_required" || e.code === "session_expired" || e.code === "list_not_found") {
        // Nothing more can be written; report this and the rest as missing with the reason.
        if (results.length === 0 && !options.newList) throw e;
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
        if (r.status !== "uncertain") continue;
        const req = items.find((x) => x.productId === r.productId)!;
        const rows = fresh.items.filter((x) => x.productId === r.productId);
        // Only a single row exactly as requested proves the write went through.
        if (rows.length === 1 && matches(rows[0]!, req)) {
          const status = wasOnList.has(r.productId) ? "updated" : "added";
          results[i] = { productId: r.productId, requestedQuantity: r.requestedQuantity, status, item: rows[0]!, ...warningFor(checks.get(r.productId)) };
        }
      }
    }
  }
  return { list, results };
}

function matches(item: ShoppingListItem, req: RequestedItem): boolean {
  return item.quantity === req.quantity && item.allowSubstitutes === req.allowSubstitutes;
}

/** Pieces must be whole; weighed products may be any positive amount. The tools allow at most 99. */
function quantityProblem(found: ListableProduct | undefined, quantity: number): ItemError | null {
  if (!found) return null;
  if (quantity > 99) return itemError("invalid_quantity", "too_many");
  if (found.product.priceBasis === "per_item" && !Number.isInteger(quantity)) return itemError("invalid_quantity", "whole_pieces_only");
  return null;
}

function mergeDuplicates(items: RequestedItem[]): RequestedItem[] {
  const merged = new Map<string, RequestedItem>();
  for (const item of items) {
    const prev = merged.get(item.productId);
    // Rounded to grams, so 0.1 + 0.2 kg is 0.3 and not 0.30000000000000004.
    merged.set(item.productId, prev ? { ...item, quantity: Math.round((prev.quantity + item.quantity) * 1000) / 1000 } : { ...item });
  }
  return [...merged.values()];
}

async function tryCheckBasket(
  client: SKaupatClient,
  storeId: string,
  items: RequestedItem[],
  delivery: BasketDelivery | undefined,
): Promise<Map<string, BasketCheck>> {
  try {
    return await client.checkBasket(storeId, items.map((i) => ({ id: i.productId, quantity: i.quantity })), delivery);
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
