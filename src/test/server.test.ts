import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { FileStoreSelection, type StoreSelection } from "../selection.js";
import { createServer } from "../server.js";
import type { SKaupatClient } from "../client/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "catalogue.json");

async function connect(client: SKaupatClient = new FixtureSKaupatClient(fixtures), selection?: StoreSelection) {
  const server = createServer(client, { selection });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("lists the catalogue and store selection tools", async () => {
  const mcp = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_products",
    "get_selected_store",
    "search_products",
    "search_stores",
    "select_store",
  ]);
});

test("search_stores returns picker-ready stores with today's hours", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_stores", { query: "helsinki" });
  assert.equal(isError, false);
  assert.equal(data.total, 2);
  assert.equal(data.selectedStoreId, null);
  assert.deepEqual(data.stores.map((s: any) => s.id), ["fixture-store-1", "fixture-store-3"]);
  const alepa = data.stores[1];
  assert.equal(alepa.chainName, "Alepa");
  assert.equal(alepa.city, "Helsinki");
  assert.equal(alepa.isSelected, false);
  assert.equal(alepa.openingHoursToday.status, "open");
  assert.deepEqual(alepa.openingHoursToday.ranges, [{ open: "07:00", close: "23:00" }]);
  assert.equal(data.stores[0].openingHoursToday.status, "open_24h");
});

test("search_stores filters by chain and can skip opening hours", async () => {
  const mcp = await connect();
  const { data } = await call(mcp, "search_stores", { chain: "S_MARKET", includeOpeningHours: false });
  assert.deepEqual(data.stores.map((s: any) => s.id), ["fixture-store-2"]);
  assert.equal(data.stores[0].openingHoursToday, null);
});

test("product tools need a store until one is selected", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_products", { query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "store_not_selected");
  assert.equal(data.error.messageFi, "Valitse ensin oma kauppasi.");
  assert.equal((await call(mcp, "get_selected_store", {})).data.selectedStore, null);
});

test("select_store remembers the store for product tools and search", async () => {
  const mcp = await connect();
  await call(mcp, "search_stores", { query: "tampere" });
  const selected = await call(mcp, "select_store", { storeId: "fixture-store-2" });
  assert.equal(selected.isError, false);
  assert.equal(selected.data.selectedStore.name, "S-market Malli Tampere");
  assert.equal(selected.data.selectedStore.street, "Mallitie 2");
  assert.equal(selected.data.selectedStore.openingHoursWeek.length, 7);

  const products = await call(mcp, "search_products", { query: "maito" });
  assert.equal(products.data.storeId, "fixture-store-2");
  const lookup = await call(mcp, "get_products", { ids: ["0000000000017"] });
  assert.equal(lookup.data.storeId, "fixture-store-2");
  const explicit = await call(mcp, "search_products", { storeId: "fixture-store-1", query: "maito" });
  assert.equal(explicit.data.storeId, "fixture-store-1");

  const current = await call(mcp, "get_selected_store", {});
  assert.equal(current.data.selectedStore.id, "fixture-store-2");
  assert.equal(current.data.selectedStore.openingHoursToday.status, "open");
  const search = await call(mcp, "search_stores", { query: "s-market" });
  assert.equal(search.data.selectedStoreId, "fixture-store-2");
  assert.equal(search.data.stores[0].isSelected, true);
});

test("selecting an unknown store is store_not_found and keeps the old choice", async () => {
  const mcp = await connect();
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  const { isError, data } = await call(mcp, "select_store", { storeId: "missing" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "store_not_found");
  assert.equal(data.error.storeId, "missing");
  assert.equal((await call(mcp, "get_selected_store", {})).data.selectedStore.id, "fixture-store-1");
});

test("the selected store survives a restart via the settings file", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "skaupat-")), "nested", "settings.json");
  const first = await connect(undefined, new FileStoreSelection(path));
  await call(first, "select_store", { storeId: "fixture-store-3" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).selectedStore.id, "fixture-store-3");

  const second = await connect(undefined, new FileStoreSelection(path));
  const { data } = await call(second, "get_selected_store", {});
  assert.equal(data.selectedStore.id, "fixture-store-3");
  assert.equal(data.selectedStore.chainName, "Alepa");
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

test("unknown store is a structured store_not_found error", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_products", { storeId: "missing", query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "store_not_found");
});

test("invalid arguments are rejected", async () => {
  const mcp = await connect();
  const res = await mcp.callTool({ name: "search_products", arguments: { storeId: "", query: "maito" } });
  assert.equal(res.isError, true);
});

test("search_products pages and sorts by price", async () => {
  const mcp = await connect();
  const cheapest = await call(mcp, "search_products", { storeId: "fixture-store-1", query: "maito", sort: "price_asc", limit: 1 });
  assert.equal(cheapest.data.total, 2);
  assert.deepEqual(cheapest.data.products.map((p: any) => p.price), [1.09]);
  const next = await call(mcp, "search_products", {
    storeId: "fixture-store-1",
    query: "maito",
    sort: "price_asc",
    limit: 1,
    offset: 1,
  });
  assert.equal(next.data.offset, 1);
  assert.deepEqual(next.data.products.map((p: any) => p.price), [1.39]);
});

test("live search_products goes to S-kaupat without any hash configuration", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ data: { store: { id: "1", products: { total: 0, productListItems: [] } } } }));
  }) as unknown as typeof fetch;
  const mcp = await connect(new HttpSKaupatClient({ fetchImpl }));
  const { isError, data } = await call(mcp, "search_products", { storeId: "1", query: "maito" });
  assert.equal(isError, false);
  assert.equal(calls, 1);
  assert.deepEqual(data.products, []);
});
