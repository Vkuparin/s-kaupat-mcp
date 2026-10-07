import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { createServer } from "../server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "catalogue.json");

async function connect(client = new FixtureSKaupatClient(fixtures)) {
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("lists the three catalogue tools", async () => {
  const mcp = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_products", "search_products", "search_stores"]);
});

test("search_stores finds stores by city", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_stores", { query: "helsinki" });
  assert.equal(isError, false);
  assert.deepEqual(data.stores.map((s: any) => s.id), ["fixture-store-1", "fixture-store-3"]);
});

test("search_products returns products with explicit unknowns", async () => {
  const mcp = await connect();
  const { data } = await call(mcp, "search_products", { storeId: "fixture-store-1", query: "maito" });
  assert.equal(data.products.length, 2);
  assert.equal(data.products[0].availability, "unknown");
  assert.ok(data.products[0].observedAt);
});

test("get_products reports found and not_found per ID", async () => {
  const mcp = await connect();
  const { data } = await call(mcp, "get_products", { storeId: "fixture-store-1", ids: ["0000000000031", "nope"] });
  assert.deepEqual(data.results.map((r: any) => r.status), ["found", "not_found"]);
  assert.equal(data.results[0].product.priceBasis, "per_weight");
});

test("unknown store is a structured unavailable error", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_products", { storeId: "missing", query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "unavailable");
});

test("invalid arguments are rejected", async () => {
  const mcp = await connect();
  const res = await mcp.callTool({ name: "search_products", arguments: { storeId: "", query: "maito" } });
  assert.equal(res.isError, true);
});

test("live mode without hashes reports unsupported", async () => {
  const mcp = await connect(new HttpSKaupatClient({ fetchImpl: () => assert.fail("must not fetch") }) as any);
  const { isError, data } = await call(mcp, "search_products", { storeId: "1", query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "unsupported");
});
