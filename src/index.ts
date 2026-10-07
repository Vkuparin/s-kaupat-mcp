#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpAuthApi } from "./auth/auth-api.js";
import { FixtureAuth } from "./auth/fixture-auth.js";
import { BrowserLoginWindow } from "./auth/login-window.js";
import { LiveAuth } from "./auth/session.js";
import { createTokenStore, defaultDataDir } from "./auth/token-store.js";
import type { SKaupatAuth } from "./auth/types.js";
import { FixtureSKaupatClient } from "./client/fixture-client.js";
import { HttpSKaupatClient } from "./client/http-client.js";
import type { SKaupatClient } from "./client/types.js";
import type { ShoppingListApi } from "./lists/types.js";
import { log } from "./log.js";
import { defaultSettingsPath, FileStoreSelection } from "./selection.js";
import { createServer, SERVER_VERSION } from "./server.js";

function createClient(): SKaupatClient & ShoppingListApi {
  const mode = process.env.SKAUPAT_MODE ?? "live";
  if (mode === "fixtures") {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = process.env.SKAUPAT_FIXTURES ?? join(here, "..", "fixtures", "catalogue.json");
    log.info("Using fixture catalogue (no network)", { path });
    return new FixtureSKaupatClient(path);
  }
  if (mode !== "live") throw new Error(`Unknown SKAUPAT_MODE: ${mode} (expected "live" or "fixtures")`);
  return new HttpSKaupatClient();
}

function createAuth(): SKaupatAuth {
  if ((process.env.SKAUPAT_MODE ?? "live") === "fixtures") return new FixtureAuth();
  const dataDir = defaultDataDir();
  const { store, lockPath } = createTokenStore(dataDir);
  log.info("Login is kept in", { store: store.description });
  return new LiveAuth({
    store,
    lockPath,
    api: new HttpAuthApi(),
    window: new BrowserLoginWindow({ profileDir: join(dataDir, "login-browser"), startUrl: process.env.SKAUPAT_LOGIN_URL }),
    backgroundRenewal: true,
  });
}

async function main(): Promise<void> {
  const selection = new FileStoreSelection(process.env.SKAUPAT_SETTINGS_FILE ?? defaultSettingsPath());
  const client = createClient();
  const server = createServer(client, createAuth(), { selection, lists: client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`s-kaupat-mcp ${SERVER_VERSION} ready on stdio`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
