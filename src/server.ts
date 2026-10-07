import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { storeNotFound, storeNotSelected, toSKaupatError } from "./errors.js";
import { log } from "./log.js";
import { STORE_CHAINS, type SKaupatClient, type Store, type StoreDetails } from "./client/types.js";
import { MemoryStoreSelection, type SavedStore, type StoreSelection } from "./selection.js";
import { chainName, finnishDate, openingHoursOn, openingHoursWeek } from "./stores.js";

export const SERVER_NAME = "s-kaupat";
export const SERVER_VERSION = "0.1.0";
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

export function createServer(client: SKaupatClient, options: ServerOptions = {}): McpServer {
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
        "product IDs, prices, comparison prices and units. Fields S-kaupat did not report are null rather " +
        "than guessed. Fails with store_not_selected when no store is chosen.",
      inputSchema: {
        storeId,
        query: z.string().min(1).describe("Search text, e.g. 'maito' or 'ruisleipä'."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum products to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, query, limit }) =>
      run("search_products", () => client.searchProducts({ storeId: resolveStoreId(storeId), query, limit })),
  );

  server.registerTool(
    "get_products",
    {
      title: "Get S-kaupat products by ID",
      description:
        "Refresh exact products by ID in one store (the user's chosen store unless storeId is given). Each ID " +
        "comes back as found, not_found or unknown; unknown means the lookup could not confirm either way.",
      inputSchema: {
        storeId,
        ids: z.array(z.string().min(1)).min(1).max(20).describe("Product IDs from search_products."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, ids }) =>
      run("get_products", () => client.getProducts({ storeId: resolveStoreId(storeId), ids: [...new Set(ids)] })),
  );

  return server;
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
      error: { code: e.code, message: e.message, ...(e.messageFi ? { messageFi: e.messageFi } : {}), ...e.details },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
      structuredContent: error,
      isError: true,
    };
  }
}
