#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FixtureSKaupatClient } from "./client/fixture-client.js";
import { HttpSKaupatClient } from "./client/http-client.js";
import type { SKaupatClient } from "./client/types.js";
import { log } from "./log.js";
import { defaultSettingsPath, FileStoreSelection } from "./selection.js";
import { createServer, SERVER_VERSION } from "./server.js";

function createClient(): SKaupatClient {
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

async function main(): Promise<void> {
  const selection = new FileStoreSelection(process.env.SKAUPAT_SETTINGS_FILE ?? defaultSettingsPath());
  const server = createServer(createClient(), { selection });
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
