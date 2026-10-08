#!/usr/bin/env node
// Command-line entry point: runs the server on stdio, or on local HTTP with --http-port. Apps
// "s-kaupat-mcp" (src/lib.ts) instead.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, usage } from "./config.js";
import { startHttpServer } from "./http.js";
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
  let stopServer: () => Promise<void>;
  if (config.httpPort !== null) {
    const http = await startHttpServer(runtime, { host: config.httpHost, port: config.httpPort, accessKey: config.accessKey! });
    stopServer = http.close;
    log.info(`s-kaupat-mcp ${SERVER_VERSION} ready`, { url: http.url, mode: config.mode, dataDir: config.dataDir });
  } else {
    const server = runtime.createMcpServer();
    await server.connect(new StdioServerTransport());
    stopServer = () => server.close();
    log.info(`s-kaupat-mcp ${SERVER_VERSION} ready on stdio`, { mode: config.mode, dataDir: config.dataDir });
    // An MCP client ends a stdio server by closing its stdin.
    process.stdin.on("end", () => void shutdown());
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
    await stopServer();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`s-kaupat-mcp: ${err.message}\n`);
    process.exit(2);
  }
  log.error("Fatal error", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
