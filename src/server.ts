import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ERROR_ACTIONS, listNotFound, SKaupatError, storeNotFound, storeNotSelected, toSKaupatError, USER_MESSAGES } from "./errors.js";
import { addItemsToList, type ListWriteResult, type WithToken } from "./lists/service.js";
import type { ShoppingList, ShoppingListApi } from "./lists/types.js";
import { log } from "./log.js";
import type { SKaupatAuth } from "./auth/types.js";
import { PRODUCT_SORTS, STORE_CHAINS, type Category, type SKaupatClient, type Store, type StoreDetails } from "./client/types.js";
import { MemoryStoreSelection, type SavedStore, type StoreSelection } from "./selection.js";
import { chainName, finnishDate, openingHoursOn, openingHoursWeek } from "./stores.js";

export const SERVER_NAME = "s-kaupat";
export const SERVER_VERSION = "0.5.0";
/** Bumped when tool inputs or result shapes change incompatibly. */
export const SCHEMA_VERSION = "0.3";

const storeId = z
  .string()
  .min(1)
  .optional()
  .describe(
    "S-kaupat store ID. Leave out to use the store the user chose with select_store. " +
      "Prices and availability are per store.",
  );

export interface ServerOptions {
  /** Where the user's chosen store is remembered. Defaults to memory only. */
  selection?: StoreSelection;
  /** Clock, for tests. */
  now?: () => Date;
  /** Shopping-list calls (need a login). Without it the list tools answer unsupported. */
  lists?: ShoppingListApi;
  /** demo: sample data, no S-kaupat account (the extension's Demo mode). Reported by get_setup_status. */
  mode?: "live" | "demo";
}

/** Read by MCP clients that pass server instructions to the model. */
export const SERVER_INSTRUCTIONS = [
  "S-kaupat (Finnish grocery store) tools. Typical flow:",
  "1. Call get_setup_status first. If nextStep is choose_store, help the user pick a store with search_stores and select_store.",
  "2. Search with search_products (queries in Finnish work best, e.g. 'maito', 'ruisleipä') or browse with list_categories and browse_category.",
  "3. Shopping lists need a login. If a call fails with error.action log_in, ask the user to log in; call start_login only when the user agrees, never on your own.",
  "4. Put products on a list with create_shopping_list or add_to_shopping_list and tell the user what each result says (added, missing with reason, warnings).",
  "5. The user finishes on the S-kaupat site: open the list, press 'Lisää kaikki ostoskoriin' (the first time the site asks for the store and pickup or delivery), check out. These tools never place orders or pay.",
  "Every error has code, action, retryable and userMessage {fi, en}; show userMessage to the user in their language and follow action.",
].join("\n");

export function createServer(client: SKaupatClient, auth: SKaupatAuth, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const selection = options.selection ?? new MemoryStoreSelection();
  const now = options.now ?? (() => new Date());
  /** Stores seen in search results, so select_store can save the address the user saw. */
  const seenStores = new Map<string, Store>();

  const resolveStoreId = (id: string | undefined): string => {
    const resolved = id ?? selection.get()?.id;
    if (!resolved) throw storeNotSelected();
    return resolved;
  };

  server.registerTool(
    "get_setup_status",
    {
      title: "Check what is set up",
      description:
        "One call for an app's first screen: whether a store is chosen, whether the user is logged in, and " +
        "nextStep: choose_store, log_in or null when everything is ready. Searching works once a store is " +
        "chosen; shopping lists also need a login. mode is demo when the server uses sample data. Never opens " +
        "a login window.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("get_setup_status", async () => {
        const store = selection.get() ?? null;
        let login: { status: string; displayName: string | null };
        try {
          login = await auth.status();
        } catch (err) {
          // Login state is one part of the answer; a hiccup there must not hide the rest.
          log.warn("Could not read the login status", { code: toSKaupatError(err).code });
          login = { status: "unknown", displayName: null };
        }
        // "unknown" counts as logged in: a list call will say if it is not, and the app shouldn't nag.
        const loggedIn = login.status === "logged_in" || login.status === "unknown";
        return {
          mode: options.mode ?? "live",
          store: store ? { id: store.id, name: store.name, chainName: store.chainName } : null,
          login: { status: login.status, displayName: login.displayName },
          canSearch: store !== null,
          canUseLists: store !== null && loggedIn,
          nextStep: store === null ? "choose_store" : loggedIn ? null : "log_in",
        };
      }),
  );

  server.registerTool(
    "search_stores",
    {
      title: "Search S-kaupat stores",
      description:
        "Find S-kaupat stores (Prisma, S-market, Alepa, Sale…) by name, city or postal code, optionally " +
        "filtered by chain. Built for a store picker: each store has a display name, chain, address, " +
        "coordinates and today's opening hours. Pass the chosen store's id to select_store.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Store name, city or postal code, e.g. 'Tampere', 'Kamppi' or '00100'."),
        chain: z.enum(STORE_CHAINS).optional().describe("Only stores of this chain."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum stores to return."),
        includeOpeningHours: z
          .boolean()
          .default(true)
          .describe("Add today's opening hours to each store (one extra request)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, chain, limit, includeOpeningHours }) =>
      run("search_stores", async () => {
        const result = await client.searchStores({ query, chain, limit });
        for (const store of result.stores) seenStores.set(store.id, store);
        const details = includeOpeningHours ? await tryGetStores(client, result.stores.map((s) => s.id)) : null;
        const today = finnishDate(now());
        const selectedId = selection.get()?.id ?? null;
        return {
          total: result.total,
          selectedStoreId: selectedId,
          stores: result.stores.map((store) => ({
            ...store,
            isSelected: store.id === selectedId,
            openingHoursToday: openingHoursOn(details?.get(store.id)?.openingHours, today),
          })),
        };
      }),
  );

  server.registerTool(
    "select_store",
    {
      title: "Choose the user's store",
      description:
        "Save the store the user picked (an id from search_stores). It is remembered across restarts, and " +
        "search_products and get_products use it when no storeId is given. Returns the saved store with " +
        "opening hours for the coming week.",
      inputSchema: {
        storeId: z.string().min(1).describe("Store ID from search_stores."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ storeId }) =>
      run("select_store", async () => {
        const details = (await client.getStores([storeId])).get(storeId);
        if (!details) throw storeNotFound(storeId);
        const store: SavedStore = {
          ...(seenStores.get(storeId) ?? storeFromDetails(details)),
          selectedAt: now().toISOString(),
        };
        selection.set(store);
        return { selectedStore: storeView(store, details, now()) };
      }),
  );

  server.registerTool(
    "get_selected_store",
    {
      title: "Get the user's chosen store",
      description:
        "Return the store the user chose with select_store, with opening hours, or selectedStore: null when " +
        "none is chosen yet (show the store picker then).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("get_selected_store", async () => {
        const saved = selection.get();
        if (!saved) return { selectedStore: null };
        let details: StoreDetails | null | undefined;
        try {
          details = (await client.getStores([saved.id])).get(saved.id) ?? null;
        } catch (err) {
          // The choice itself is still valid offline; only the opening hours are missing.
          log.warn("Could not refresh the selected store", { code: toSKaupatError(err).code });
        }
        if (details === null) throw storeNotFound(saved.id);
        return { selectedStore: storeView(saved, details ?? undefined, now()) };
      }),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search S-kaupat products",
      description:
        "Search products in one S-kaupat store (the user's chosen store unless storeId is given). Returns " +
        "product IDs (EAN barcodes), prices, campaign prices, comparison prices, category, shelf location and " +
        "an image URL. Fields S-kaupat did not report are null rather than guessed. Use offset to page through " +
        "more results. Fails with store_not_selected when no store is chosen.",
      inputSchema: {
        storeId,
        query: z.string().min(1).describe("Search text in Finnish, e.g. 'maito' or 'ruisleipä'."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum products to return."),
        offset: z.number().int().min(0).max(1000).default(0).describe("Products to skip, for the next page."),
        sort: z
          .enum(PRODUCT_SORTS)
          .default("relevance")
          .describe(
            "relevance (S-kaupat's own ranking), price_asc or price_desc. A price sort orders the 50 most " +
              "relevant matches, so 'cheapest milk' stays milk; for a whole category by price use browse_category.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, query, limit, offset, sort }) =>
      run("search_products", () =>
        client.searchProducts({ storeId: resolveStoreId(storeId), query, limit, offset, sort }),
      ),
  );

  server.registerTool(
    "get_products",
    {
      title: "Get S-kaupat products by ID",
      description:
        "Refresh exact products by ID (EAN) in one store (the user's chosen store unless storeId is given), in " +
        "one request. Each ID comes back as found (with current price) or not_found (not sold in that store, " +
        "or not a known barcode).",
      inputSchema: {
        storeId,
        ids: z.array(z.string().min(1)).min(1).max(20).describe("Product IDs from search_products."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, ids }) =>
      run("get_products", () => client.getProducts({ storeId: resolveStoreId(storeId), ids: [...new Set(ids)] })),
  );

  server.registerTool(
    "login_status",
    {
      title: "S-kaupat login status",
      description:
        "Whether the user is logged in to S-kaupat on this device: logged_in (with the account holder's name), " +
        "logged_out or expired. Never opens a window. Catalogue tools work without logging in.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => run("login_status", () => auth.status()),
  );

  server.registerTool(
    "start_login",
    {
      title: "Log in to S-kaupat",
      description:
        "Opens a small S-kaupat login window on the user's screen and waits until they log in, close the window " +
        "or the time runs out. Call it only when the user asks to log in, for example from a 'Log in' button; " +
        "never call it on your own in the middle of another task. Returns logged_in, cancelled or timed_out, " +
        "with messages in Finnish and English to show the user. If already logged in, returns at once.",
      inputSchema: {
        timeoutSeconds: z
          .number()
          .int()
          .min(30)
          .max(900)
          .default(300)
          .describe("How long to wait for the user to finish logging in."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ timeoutSeconds }) =>
      run("start_login", async () => {
        const result = await auth.startLogin({ timeoutSeconds });
        return { ...result, userMessage: LOGIN_MESSAGES[result.status] };
      }),
  );

  server.registerTool(
    "get_product_details",
    {
      title: "Get S-kaupat product details",
      description:
        "The product page for one product in the user's store: everything search_products returns plus " +
        "description, ingredients, allergens (contains, may_contain or free_from), nutrition per 100 g or 100 ml, " +
        "country of origin, supplier and net weight. Texts are in Finnish as S-kaupat gives them. Fails with " +
        "product_unavailable when the store does not know the product.",
      inputSchema: {
        productId: z.string().min(1).describe("Product ID (EAN) from search_products or browse_category."),
        storeId,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ productId, storeId }) =>
      run("get_product_details", async () => {
        const store = resolveStoreId(storeId);
        const product = await client.getProductDetails(store, productId);
        if (!product) {
          throw new SKaupatError("product_unavailable", `Product ${productId} was not found in store ${store}.`, {
            productId,
          });
        }
        return { product };
      }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List S-kaupat product categories",
      description:
        "The store's product categories in Finnish, for a category menu. Without parent, returns the top level; " +
        "with parent (a category slug), returns that category's subcategories. Each category has a slug for " +
        "browse_category and a childCount. The tree has three levels.",
      inputSchema: {
        storeId,
        parent: z
          .string()
          .min(1)
          .optional()
          .describe("Slug of the category whose subcategories to list, e.g. 'maito-munat-ja-rasvat'."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(1)
          .describe("How many levels to include below the starting point."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, parent, depth }) =>
      run("list_categories", async () => {
        const store = resolveStoreId(storeId);
        const tree = await client.getCategories(store);
        let level = tree;
        let parentCategory: Category | null = null;
        if (parent) {
          parentCategory = findCategory(tree, parent);
          if (!parentCategory) {
            throw new SKaupatError("invalid_argument", `No category with slug ${parent} in store ${store}.`, { parent });
          }
          level = parentCategory.children;
        }
        return {
          storeId: store,
          parent: parentCategory ? { id: parentCategory.id, name: parentCategory.name, slug: parentCategory.slug } : null,
          categories: level.map((c) => categoryView(c, depth)),
        };
      }),
  );

  server.registerTool(
    "browse_category",
    {
      title: "Browse an S-kaupat category",
      description:
        "Products in one category of the user's store (slug from list_categories, or a product's categorySlug), " +
        "with the same product fields as search_products. Use offset to page and sort for cheapest first.",
      inputSchema: {
        storeId,
        slug: z.string().min(1).describe("Category slug, e.g. 'maito-munat-ja-rasvat/maidot-ja-piimat/maidot'."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum products to return."),
        offset: z.number().int().min(0).max(1000).default(0).describe("Products to skip, for the next page."),
        sort: z.enum(PRODUCT_SORTS).default("relevance").describe("relevance, price_asc or price_desc."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, slug, limit, offset, sort }) =>
      run("browse_category", () => client.browseCategory({ storeId: resolveStoreId(storeId), slug, limit, offset, sort })),
  );

  const storeNameFor = (id: string): string | null => {
    const saved = selection.get();
    return saved?.id === id ? saved.name : seenStores.get(id)?.name ?? null;
  };
  const withToken: WithToken = (fn) => (auth.withAccessToken ? auth.withAccessToken(fn) : auth.getAccessToken().then(fn));
  const requireLists = (): ShoppingListApi => {
    if (!options.lists) throw new SKaupatError("unsupported", "Shopping lists are not available in this server.");
    return options.lists;
  };
  const getListOrThrow = async (listId: string, store: string): Promise<ShoppingList> => {
    const list = await withToken((t) => requireLists().getList(t, listId, store));
    if (!list) throw listNotFound(listId);
    return list;
  };

  const listItems = z
    .array(
      z.object({
        productId: z.string().min(1).describe("Product ID (EAN) from search_products."),
        quantity: z
          .number()
          .positive()
          .max(99)
          .default(1)
          .describe("How many (pieces), or kilograms for products sold by weight (priceBasis per_weight)."),
        allowSubstitutes: z
          .boolean()
          .default(true)
          .describe("Whether the store may pick a similar product if this one is out of stock."),
      }),
    )
    .max(50);
  const listStoreId = storeId.describe(
    "Store whose prices to show for list items. Leave out to use the store the user chose with select_store.",
  );

  server.registerTool(
    "get_shopping_lists",
    {
      title: "Get the user's S-kaupat shopping lists",
      description:
        "All of the logged-in user's S-kaupat shopping lists, with their items and current prices in the user's " +
        "store. Needs a login: fails with login_required or session_expired, then the app shows its 'Log in' " +
        "button (start_login).",
      inputSchema: { storeId: listStoreId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId }) =>
      run("get_shopping_lists", async () => {
        const store = resolveStoreId(storeId);
        const lists = await withToken((t) => requireLists().getLists(t, store));
        return { storeId: store, lists: lists.map(listView) };
      }),
  );

  server.registerTool(
    "get_shopping_list",
    {
      title: "Get one S-kaupat shopping list",
      description:
        "One shopping list with its items, current prices in the user's store and an estimated total. Fails with " +
        "list_not_found if it was deleted. Needs a login.",
      inputSchema: { listId: z.string().min(1).describe("List ID from get_shopping_lists."), storeId: listStoreId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ listId, storeId }) =>
      run("get_shopping_list", async () => {
        const store = resolveStoreId(storeId);
        return { list: listView(await getListOrThrow(listId, store)) };
      }),
  );

  server.registerTool(
    "create_shopping_list",
    {
      title: "Create an S-kaupat shopping list",
      description:
        "Create a new shopping list on the user's S-kaupat account, optionally with products. Returns the list " +
        "and, per product, whether it was added or is missing (with a reason and Finnish and English messages). " +
        "The user finishes on the S-kaupat site: open the list and press 'Lisää kaikki ostoskoriin' (add all to " +
        "cart), then check out. Needs a login.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .describe("List name, e.g. 'Viikonloppu'. Plain words work best; the site rejects some punctuation."),
        items: listItems.default([]).describe("Products to put on the new list."),
        storeId: listStoreId,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, items, storeId }) =>
      run("create_shopping_list", async () => {
        const store = resolveStoreId(storeId);
        const lists = requireLists();
        const list = await withToken((t) => lists.createList(t, name, store));
        // The list exists now: whatever happens with the products, the caller gets the list back.
        const result = await addItemsToList({ client, lists, withToken, storeId: store, list, items, newList: true }).catch(
          (err): ListWriteResult => {
            const e = toSKaupatError(err);
            return {
              list,
              results: items.map((i) => ({
                productId: i.productId,
                requestedQuantity: i.quantity,
                status: "missing",
                name: null,
                error: { code: e.code, reason: "write_failed", userMessage: USER_MESSAGES[e.code] },
              })),
            };
          },
        );
        return listWriteView(result, storeNameFor(store));
      }),
  );

  server.registerTool(
    "add_to_shopping_list",
    {
      title: "Add products to an S-kaupat shopping list",
      description:
        "Put products on an existing shopping list. A product already on the list gets the quantity given here " +
        "(it is not added twice). Returns, per product, added, updated, unchanged, missing (not sold in this " +
        "store or unknown barcode) or uncertain, so the app can show exactly what happened. Products S-kaupat " +
        "says are out of stock are still added, with a warning. Needs a login.",
      inputSchema: {
        listId: z.string().min(1).describe("List ID from get_shopping_lists or create_shopping_list."),
        items: listItems.min(1),
        storeId: listStoreId,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ listId, items, storeId }) =>
      run("add_to_shopping_list", async () => {
        const store = resolveStoreId(storeId);
        const lists = requireLists();
        const list = await getListOrThrow(listId, store);
        return listWriteView(await addItemsToList({ client, lists, withToken, storeId: store, list, items }), storeNameFor(store));
      }),
  );

  server.registerTool(
    "remove_from_shopping_list",
    {
      title: "Remove products from an S-kaupat shopping list",
      description:
        "Take products off a shopping list by product ID. Returns the list afterwards and which products were " +
        "removed or were not on the list. Needs a login.",
      inputSchema: {
        listId: z.string().min(1).describe("List ID from get_shopping_lists."),
        productIds: z.array(z.string().min(1)).min(1).max(50).describe("Product IDs (EANs) to remove."),
        storeId: listStoreId,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ listId, productIds, storeId }) =>
      run("remove_from_shopping_list", async () => {
        const store = resolveStoreId(storeId);
        const lists = requireLists();
        let list = await getListOrThrow(listId, store);
        const removed: string[] = [];
        const notOnList: string[] = [];
        for (const productId of new Set(productIds)) {
          const rows = list.items.filter((i) => i.productId === productId);
          if (rows.length === 0) notOnList.push(productId);
          for (const row of rows) list = await withToken((t) => lists.removeItem(t, list.id, row.itemId, store));
          if (rows.length > 0) removed.push(productId);
        }
        return { list: listView(list), removed, notOnList };
      }),
  );

  server.registerTool(
    "delete_shopping_list",
    {
      title: "Delete an S-kaupat shopping list",
      description:
        "Permanently delete a whole shopping list from the user's S-kaupat account. Only call this when the user " +
        "has clearly asked to delete that list. Needs a login.",
      inputSchema: { listId: z.string().min(1).describe("List ID from get_shopping_lists.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ listId }) =>
      run("delete_shopping_list", async () => {
        const lists = requireLists();
        await withToken((t) => lists.deleteList(t, listId));
        return { deletedListId: listId };
      }),
  );

  return server;
}

const LOGIN_MESSAGES = {
  logged_in: { fi: "Olet kirjautunut S-kaupat-tilillesi.", en: "You are logged in to your S-kaupat account." },
  cancelled: { fi: "Kirjautuminen keskeytettiin.", en: "Login was cancelled." },
  timed_out: { fi: "Kirjautuminen aikakatkaistiin. Yritä uudelleen.", en: "Login timed out. Please try again." },
};

function findCategory(tree: Category[], slug: string): Category | null {
  for (const c of tree) {
    if (c.slug === slug) return c;
    const found = findCategory(c.children, slug);
    if (found) return found;
  }
  return null;
}

interface CategoryView {
  id: string;
  name: string;
  slug: string;
  childCount: number;
  children?: CategoryView[];
}

function categoryView(c: Category, depth: number): CategoryView {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    childCount: c.children.length,
    ...(depth > 1 ? { children: c.children.map((child) => categoryView(child, depth - 1)) } : {}),
  };
}

/**
 * Where the user finishes: the site turns a list into a cart with one button. The site keeps its own
 * store choice in the browser, so the first time it asks for a store and a delivery method before
 * the button works (seen live 2026-10-08).
 */
function listNextStep(storeName: string | null) {
  const fiStore = storeName ? `kaupaksi ${storeName}` : "kauppasi";
  const enStore = storeName ? `${storeName} as the store` : "your store";
  return {
    fi:
      "Avaa ostoslista S-kaupat-sivulla ja paina \"Lisää kaikki ostoskoriin\". Jos sivu kysyy, valitse " +
      `${fiStore} sekä nouto tai kotiinkuljetus. Tilaus vahvistetaan sivulla.`,
    en:
      "Open the list on the S-kaupat site and press \"Lisää kaikki ostoskoriin\" (add all to cart). If the site " +
      `asks, choose ${enStore} and pickup or home delivery. Then check out there.`,
  };
}

function listView(list: ShoppingList) {
  let amount = 0;
  let complete = true;
  for (const item of list.items) {
    const price = item.product?.price;
    if (price == null) complete = false;
    else amount += price * item.quantity;
    if (item.product?.approximatePrice) complete = false;
  }
  return {
    ...list,
    itemCount: list.items.length,
    // Euros at current shelf prices; complete is false when a price is missing or approximate (weighed goods).
    estimatedTotal: { amount: Math.round(amount * 100) / 100, complete },
  };
}

function listWriteView({ list, results }: ListWriteResult, storeName: string | null) {
  const count = (status: string) => results.filter((r) => r.status === status).length;
  return {
    list: listView(list),
    // The full product is already in list.items; a result names the row so the answer stays small.
    results: results.map((r) =>
      "item" in r ? { ...r, item: { itemId: r.item.itemId, name: r.item.name, quantity: r.item.quantity, allowSubstitutes: r.item.allowSubstitutes } } : r,
    ),
    summary: {
      added: count("added"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      missing: count("missing"),
      uncertain: count("uncertain"),
      withWarnings: results.filter((r) => "warning" in r && r.warning).length,
    },
    nextStep: listNextStep(storeName),
  };
}

/** Opening hours are a nice-to-have in search results; a failure must not hide the stores. */
async function tryGetStores(client: SKaupatClient, ids: string[]): Promise<Map<string, StoreDetails> | null> {
  if (ids.length === 0) return new Map();
  try {
    return await client.getStores(ids);
  } catch (err) {
    log.warn("Could not fetch opening hours for search results", { code: toSKaupatError(err).code });
    return null;
  }
}

function storeFromDetails(d: StoreDetails): Store {
  return {
    id: d.id,
    name: d.name,
    chain: d.chain,
    chainName: chainName(d.chain),
    street: null,
    postalCode: null,
    city: null,
    coordinates: null,
    onlineOrdering: null,
  };
}

function storeView(store: SavedStore, details: StoreDetails | undefined, now: Date) {
  const today = finnishDate(now);
  return {
    ...store,
    openingHoursToday: openingHoursOn(details?.openingHours, today),
    openingHoursWeek: details ? openingHoursWeek(details.openingHours, today) : null,
  };
}

async function run(tool: string, fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    const result = { schemaVersion: SCHEMA_VERSION, ...(await fn()) };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  } catch (err) {
    const e = toSKaupatError(err);
    log.error(`${tool} failed`, { code: e.code, message: e.message });
    const error = {
      schemaVersion: SCHEMA_VERSION,
      error: { code: e.code, ...ERROR_ACTIONS[e.code], message: e.message, userMessage: USER_MESSAGES[e.code], ...e.details },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
      structuredContent: error,
      isError: true,
    };
  }
}
