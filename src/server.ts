import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toSKaupatError } from "./errors.js";
import { log } from "./log.js";
import type { SKaupatClient } from "./client/types.js";

export const SERVER_NAME = "s-kaupat";
export const SERVER_VERSION = "0.1.0";
/** Bumped when tool inputs or result shapes change incompatibly. */
export const SCHEMA_VERSION = "0.1";

const storeId = z
  .string()
  .min(1)
  .describe("S-kaupat store ID from search_stores. Prices and availability are per store.");

export function createServer(client: SKaupatClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "search_stores",
    {
      title: "Search S-kaupat stores",
      description:
        "Find S-kaupat stores (Prisma, S-market, Alepa, Sale…) by name, city or postal code. " +
        "Returns store IDs needed by search_products and get_products.",
      inputSchema: {
        query: z.string().min(1).describe("Store name, city or postal code, e.g. 'Kamppi' or '00100'."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum stores to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => run("search_stores", async () => ({ stores: await client.searchStores({ query, limit }) })),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search S-kaupat products",
      description:
        "Search products in one S-kaupat store. Returns product IDs, prices, comparison prices and units. " +
        "Fields S-kaupat did not report are null rather than guessed.",
      inputSchema: {
        storeId,
        query: z.string().min(1).describe("Search text, e.g. 'maito' or 'ruisleipä'."),
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum products to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, query, limit }) =>
      run("search_products", () => client.searchProducts({ storeId, query, limit })),
  );

  server.registerTool(
    "get_products",
    {
      title: "Get S-kaupat products by ID",
      description:
        "Refresh exact products by ID in one store. Each ID comes back as found, not_found or unknown; " +
        "unknown means the lookup could not confirm either way.",
      inputSchema: {
        storeId,
        ids: z.array(z.string().min(1)).min(1).max(20).describe("Product IDs from search_products."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ storeId, ids }) => run("get_products", () => client.getProducts({ storeId, ids: [...new Set(ids)] })),
  );

  return server;
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
    const error = { schemaVersion: SCHEMA_VERSION, error: { code: e.code, message: e.message, ...e.details } };
    return {
      content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
      structuredContent: error,
      isError: true,
    };
  }
}
