import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, loadConfig, SERVER_VERSION } from "../lib.js";

test("an app can run the server in its own process, with its own data folder", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "skaupat-lib-"));
  const { config } = loadConfig({ env: {}, argv: ["--demo", "--data-dir", dataDir] });
  const runtime = createRuntime(config);

  // Two connections share one runtime: the store chosen through one is seen by the other.
  const connect = async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "app", version: "1.0.0" });
    await Promise.all([runtime.createMcpServer().connect(b), client.connect(a)]);
    return client;
  };
  const first = await connect();
  const second = await connect();
  assert.equal(first.getServerVersion()?.version, SERVER_VERSION);
  await first.callTool({ name: "select_store", arguments: { storeId: "fixture-store-1" } });
  const status = (await second.callTool({ name: "get_setup_status", arguments: {} })).structuredContent as any;
  assert.equal(status.mode, "demo");
  assert.equal(status.store.id, "fixture-store-1");
  await runtime.close();
});
