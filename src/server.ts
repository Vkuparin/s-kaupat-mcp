import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { toSKaupatError, USER_MESSAGES } from "./errors.js";
import { log } from "./log.js";
import type { SKaupatAuth } from "./auth/types.js";
import type { SKaupatClient } from "./client/types.js";

export const SERVER_NAME = "s-kaupat";
export const SERVER_VERSION = "0.2.0";
/** Bumped when tool inputs or result shapes change incompatibly. */
export const SCHEMA_VERSION = "0.2";

const storeId = z
  .string()
  .min(1)
  .describe("S-kaupat store ID from search_stores. Prices and availability are per store.");

export function createServer(client: SKaupatClient, auth: SKaupatAuth): McpServer {
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
