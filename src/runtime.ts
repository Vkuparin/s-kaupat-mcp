import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpAuthApi } from "./auth/auth-api.js";
import { FixtureAuth } from "./auth/fixture-auth.js";
import { BrowserLoginWindow } from "./auth/login-window.js";
import { LiveAuth } from "./auth/session.js";
import { createTokenStore } from "./auth/token-store.js";
import type { SKaupatAuth } from "./auth/types.js";
import { createBrowserFetch } from "./browser/browser-fetch.js";
import { BrowserSession } from "./browser/session.js";
import { FixtureSKaupatClient } from "./client/fixture-client.js";
import { HttpSKaupatClient } from "./client/http-client.js";
import type { SKaupatClient } from "./client/types.js";
import type { SKaupatConfig } from "./config.js";
import type { ShoppingListApi } from "./lists/types.js";
import { log, setDebugLogging } from "./log.js";
import { FileStoreSelection, type StoreSelection } from "./selection.js";
import { createServer } from "./server.js";

/**
 * The parts of a running server that outlive one MCP connection: the S-kaupat
 * client, the login, the browser window and the user's store choice. An app
 * creates one runtime and connects as many MCP servers to it as it needs.
 */
export interface SKaupatRuntime {
  readonly config: SKaupatConfig;
  /** A new MCP server using this runtime. Connect it to any MCP transport. */
  createMcpServer(): McpServer;
  /** Closes the browser window gracefully, so its profile is saved. Call on shutdown. */
  close(): Promise<void>;
}

export function createRuntime(config: SKaupatConfig): SKaupatRuntime {
  setDebugLogging(config.debug);
  const selection: StoreSelection = new FileStoreSelection(config.settingsFile);
  const { client, auth, browser } = config.mode === "demo" ? demoParts(config) : liveParts(config);
  return {
    config,
    createMcpServer: () => createServer(client, auth, { selection, lists: client, mode: config.mode }),
    close: async () => {
      await browser?.close();
    },
  };
}

interface Parts {
  client: SKaupatClient & ShoppingListApi;
  auth: SKaupatAuth;
  browser: BrowserSession | null;
}

function demoParts(config: SKaupatConfig): Parts {
  log.info("Demo mode: built-in sample data, no network", config.demoCatalogueFile ? { catalogue: config.demoCatalogueFile } : undefined);
  const client = config.demoCatalogueFile ? new FixtureSKaupatClient(config.demoCatalogueFile) : new FixtureSKaupatClient();
  return { client, auth: new FixtureAuth(), browser: null };
}

function liveParts(config: SKaupatConfig): Parts {
  // One browser profile for the login window and the API session, so they share the S-kaupat session.
  const profileDir = join(config.dataDir, "login-browser");
  const executablePath = config.browserPath ?? undefined;
  const browser = config.transport === "browser" ? new BrowserSession({ profileDir, executablePath }) : null;
  const fetchImpl = browser ? createBrowserFetch({ page: () => browser.apiPage() }) : undefined;
  log.info("S-kaupat transport", { transport: config.transport });

  const { store, lockPath } = createTokenStore(config);
  log.info("Login is kept in", { store: store.description });
  const loginWindow = new BrowserLoginWindow({ profileDir, executablePath, startUrl: config.loginUrl ?? undefined });
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
