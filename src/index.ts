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
import { createBrowserFetch } from "./browser/browser-fetch.js";
import { BrowserSession } from "./browser/session.js";
import { log } from "./log.js";
import { defaultSettingsPath, FileStoreSelection } from "./selection.js";
import { createServer, SERVER_VERSION } from "./server.js";

/** SKAUPAT_DEMO=true is the Claude Desktop extension's "Demo mode" switch, same as SKAUPAT_MODE=fixtures. */
function serverMode(): string {
  if (process.env.SKAUPAT_DEMO === "true") return "fixtures";
  return process.env.SKAUPAT_MODE ?? "live";
}

interface Live {
  client: SKaupatClient & ShoppingListApi;
  auth: SKaupatAuth;
  /** Closed on shutdown, so the browser profile is saved. */
  browser: BrowserSession | null;
}

function createLive(): Live {
  const mode = serverMode();
  if (mode === "fixtures") {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = process.env.SKAUPAT_FIXTURES ?? join(here, "..", "fixtures", "catalogue.json");
    log.info("Using fixture catalogue (no network)", { path });
    return { client: new FixtureSKaupatClient(path), auth: new FixtureAuth(), browser: null };
  }
  if (mode !== "live") throw new Error(`Unknown SKAUPAT_MODE: ${mode} (expected "live" or "fixtures")`);

  const dataDir = defaultDataDir();
  // One browser profile for the login window and the API session, so they share the S-kaupat session.
  const profileDir = join(dataDir, "login-browser");
  const transport = process.env.SKAUPAT_TRANSPORT ?? "browser";
  if (transport !== "browser" && transport !== "direct") {
    throw new Error(`Unknown SKAUPAT_TRANSPORT: ${transport} (expected "browser" or "direct")`);
  }
  const browser = transport === "browser" ? new BrowserSession({ profileDir }) : null;
  const fetchImpl = browser ? createBrowserFetch({ page: () => browser.apiPage() }) : undefined;
  log.info("S-kaupat transport", { transport });

  const { store, lockPath } = createTokenStore(dataDir);
  log.info("Login is kept in", { store: store.description });
  const loginWindow = new BrowserLoginWindow({ profileDir, startUrl: process.env.SKAUPAT_LOGIN_URL });
  const auth = new LiveAuth({
    store,
    lockPath,
    api: new HttpAuthApi({ fetchImpl }),
    // The login window needs the profile the API session has open: close that while the user logs in.
    window: browser ? { open: (ms, stale) => browser.whileClosed(() => loginWindow.open(ms, stale)) } : loginWindow,
    // With the browser transport, renewing in the background would open the S-kaupat window while
    // nobody uses it; the login is renewed on the next call instead.
    backgroundRenewal: !browser,
  });
  return { client: new HttpSKaupatClient({ fetchImpl }), auth, browser };
}

async function main(): Promise<void> {
  const selection = new FileStoreSelection(process.env.SKAUPAT_SETTINGS_FILE ?? defaultSettingsPath());
  const { client, auth, browser } = createLive();
  const server = createServer(client, auth, {
    selection,
    lists: client,
    mode: serverMode() === "fixtures" ? "demo" : "live",
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`s-kaupat-mcp ${SERVER_VERSION} ready on stdio`);

  const shutdown = async () => {
    await browser?.close();
    await server.close();
    process.exit(0);
  };
  // Claude Desktop ends a server by closing its stdin.
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
