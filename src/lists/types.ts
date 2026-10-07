import type { Product } from "../client/types.js";

/**
 * Shopping lists are kept server-side by S-kaupat, per user, and need a login.
 * They are the hand-off to the cart: the website has a "Lisää kaikki
 * ostoskoriin" (add all to cart) button on each list, while the cart itself
 * lives only in the user's browser. See docs/s-kaupat-api.md section 5.
 */

export interface ShoppingListItem {
  /** S-kaupat's id for this row in the list. */
  itemId: string;
  /** Product ID (EAN), as in search_products. */
  productId: string;
  name: string;
  quantity: number;
  /** Whether the store may pick a substitute if this product is out of stock. */
  allowSubstitutes: boolean;
  /** The product with current price in the requested store, or null if that store does not sell it. */
  product: Product | null;
}

export interface ShoppingList {
  id: string;
  name: string;
  createdAt: string | null;
  /** Store whose prices `items[].product` shows. */
  storeId: string;
  items: ShoppingListItem[];
}

/** What S-kaupat needs to put one product on a list (ShoppingListItemInput). */
export interface ListItemInput {
  ean: string;
  sokId: string;
  name: string;
  quantity: number;
  isReplaceable: boolean;
}

/**
 * Authenticated shopping-list calls. Every method takes the access token
 * explicitly, so the login layer decides when to renew it.
 */
export interface ShoppingListApi {
  getLists(accessToken: string, storeId: string): Promise<ShoppingList[]>;
  /** Null when the list does not exist (or belongs to someone else). */
  getList(accessToken: string, listId: string, storeId: string): Promise<ShoppingList | null>;
  createList(accessToken: string, name: string, storeId: string): Promise<ShoppingList>;
  /** Returns the list as it is after the write. */
  addItem(accessToken: string, listId: string, item: ListItemInput, storeId: string): Promise<ShoppingList>;
  /** Returns the list as it is after the write. */
  removeItem(accessToken: string, listId: string, itemId: string, storeId: string): Promise<ShoppingList>;
  deleteList(accessToken: string, listId: string): Promise<void>;
}
