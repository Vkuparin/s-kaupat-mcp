#!/usr/bin/env node
// Command-line entry point: runs the server on stdio. Apps embedding the server in Node import
// "s-kaupat-mcp" (src/lib.ts) instead.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, usage } from "./config.js";
import { log } from "./log.js";
import { createRuntime } from "./runtime.js";
import { SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const { config, cli } = loadConfig({ argv: process.argv.slice(2) });
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (cli.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const runtime = createRuntime(config);
  const server = runtime.createMcpServer();
  await server.connect(new StdioServerTransport());
  log.info(`s-kaupat-mcp ${SERVER_VERSION} ready on stdio`, { mode: config.mode, dataDir: config.dataDir });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
    await server.close();
    process.exit(0);
  };
  // An MCP client ends a stdio server by closing its stdin.
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`s-kaupat-mcp: ${err.message}\n`);
    process.exit(2);
  }
  log.error("Fatal error", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
