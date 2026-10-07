import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { storeNotFound, storeNotSelected, toSKaupatError, USER_MESSAGES } from "./errors.js";
import { log } from "./log.js";
import type { SKaupatAuth } from "./auth/types.js";
import { PRODUCT_SORTS, STORE_CHAINS, type SKaupatClient, type Store, type StoreDetails } from "./client/types.js";
import { MemoryStoreSelection, type SavedStore, type StoreSelection } from "./selection.js";
import { chainName, finnishDate, openingHoursOn, openingHoursWeek } from "./stores.js";

export const SERVER_NAME = "s-kaupat";
export const SERVER_VERSION = "0.2.0";
/** Bumped when tool inputs or result shapes change incompatibly. */
export const SCHEMA_VERSION = "0.2";

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
}

export function createServer(client: SKaupatClient, auth: SKaupatAuth, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
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
          .describe("relevance (S-kaupat's own ranking), price_asc or price_desc."),
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

  return server;
}

const LOGIN_MESSAGES = {
  logged_in: { fi: "Olet kirjautunut S-kaupat-tilillesi.", en: "You are logged in to your S-kaupat account." },
  cancelled: { fi: "Kirjautuminen keskeytettiin.", en: "Login was cancelled." },
  timed_out: { fi: "Kirjautuminen aikakatkaistiin. Yritä uudelleen.", en: "Login timed out. Please try again." },
};

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
      error: { code: e.code, message: e.message, userMessage: USER_MESSAGES[e.code], ...e.details },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
      structuredContent: error,
      isError: true,
    };
  }
}
