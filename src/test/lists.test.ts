import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureAuth } from "../auth/fixture-auth.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { SKaupatError } from "../errors.js";
import { addItemsToList } from "../lists/service.js";
import type { ShoppingListApi } from "../lists/types.js";
import { createServer } from "../server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtures = join(root, "fixtures", "catalogue.json");
const docSample = (name: string): unknown =>
  JSON.parse(readFileSync(join(root, "docs", "samples", name), "utf8")).response;

const MILK = "0000000000017";
const BREAD = "0000000000024";
const YOGURT = "0000000000055"; // out of stock in the fixture catalogue

async function connect(lists?: ShoppingListApi) {
  const client = new FixtureSKaupatClient(fixtures);
  const auth = new FixtureAuth();
  const server = createServer(client, auth, { lists: lists ?? client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

async function loggedIn() {
  const mcp = await connect();
  await call(mcp, "start_login");
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  return mcp;
}

test("list tools need a login and say so in Finnish and English", async () => {
  const mcp = await connect();
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  const { isError, data } = await call(mcp, "get_shopping_lists");
  assert.equal(isError, true);
  assert.equal(data.error.code, "login_required");
  assert.equal(data.error.userMessage.fi, "Kirjaudu ensin S-kaupat-tilillesi.");
});

test("list tools need a store", async () => {
  const mcp = await connect();
  await call(mcp, "start_login");
  const { data } = await call(mcp, "create_shopping_list", { name: "Viikonloppu" });
  assert.equal(data.error.code, "store_not_selected");
});

test("create_shopping_list reports what was added, flagged and missing", async () => {
  const mcp = await loggedIn();
  const { isError, data } = await call(mcp, "create_shopping_list", {
    name: "Viikonloppu",
    items: [
      { productId: MILK, quantity: 2 },
      { productId: YOGURT, quantity: 4, allowSubstitutes: false },
      { productId: "6400000000000", quantity: 1 },
    ],
  });
  assert.equal(isError, false);
  assert.equal(data.list.name, "Viikonloppu");
  assert.equal(data.list.itemCount, 2);
  assert.deepEqual(data.summary, { added: 2, updated: 0, unchanged: 0, missing: 1, uncertain: 0, withWarnings: 1 });

  const [milk, yogurt, unknown] = data.results;
  assert.equal(milk.status, "added");
  assert.equal(milk.item.quantity, 2);
  assert.equal(milk.item.allowSubstitutes, true);
  // The result names the row; the product with its price is in list.items.
  assert.equal(milk.item.product, undefined);
  assert.equal(data.list.items.find((i: any) => i.itemId === milk.item.itemId).product.price, 1.09);
  assert.equal(yogurt.status, "added");
  assert.equal(yogurt.item.allowSubstitutes, false);
  assert.equal(yogurt.warning.code, "product_unavailable");
  assert.equal(yogurt.warning.label, "Tilapäisesti loppu");
  assert.equal(unknown.status, "missing");
  assert.equal(unknown.error.code, "product_unavailable");
  assert.equal(unknown.error.reason, "unknown_barcode");
  assert.equal(unknown.error.userMessage.en, "This product is not available in this store.");

  assert.deepEqual(data.list.estimatedTotal, { amount: 4.94, complete: true });
  assert.match(data.nextStep.fi, /Lisää kaikki ostoskoriin/);
});

test("add_to_shopping_list sets quantities instead of adding duplicates", async () => {
  const mcp = await loggedIn();
  const created = await call(mcp, "create_shopping_list", { name: "Arki", items: [{ productId: MILK, quantity: 1 }] });
  const listId = created.data.list.id;

  const { data } = await call(mcp, "add_to_shopping_list", {
    listId,
    items: [
      { productId: MILK, quantity: 3 },
      { productId: BREAD },
      { productId: BREAD },
    ],
  });
  assert.deepEqual(
    data.results.map((r: any) => [r.productId, r.status, r.requestedQuantity]),
    [
      [MILK, "updated", 3],
      [BREAD, "added", 2],
    ],
  );
  assert.equal(data.list.itemCount, 2);
  assert.equal(data.list.items.find((i: any) => i.productId === MILK).quantity, 3);

  const again = await call(mcp, "add_to_shopping_list", { listId, items: [{ productId: BREAD, quantity: 2 }] });
  assert.equal(again.data.results[0].status, "unchanged");
  assert.equal(again.data.list.itemCount, 2);
});

test("lists can be read, trimmed and deleted", async () => {
  const mcp = await loggedIn();
  const created = await call(mcp, "create_shopping_list", {
    name: "Juhlat",
    items: [{ productId: MILK }, { productId: BREAD }],
  });
  const listId = created.data.list.id;

  const all = await call(mcp, "get_shopping_lists");
  assert.deepEqual(all.data.lists.map((l: any) => l.name), ["Juhlat"]);
  assert.equal(all.data.storeId, "fixture-store-1");

  const trimmed = await call(mcp, "remove_from_shopping_list", { listId, productIds: [MILK, "nope"] });
  assert.deepEqual(trimmed.data.removed, [MILK]);
  assert.deepEqual(trimmed.data.notOnList, ["nope"]);
  assert.deepEqual(trimmed.data.list.items.map((i: any) => i.productId), [BREAD]);

  assert.equal((await call(mcp, "delete_shopping_list", { listId })).data.deletedListId, listId);
  const gone = await call(mcp, "get_shopping_list", { listId });
  assert.equal(gone.isError, true);
  assert.equal(gone.data.error.code, "list_not_found");
  assert.equal(gone.data.error.userMessage.fi, "Ostoslistaa ei löytynyt. Se on ehkä poistettu.");
});

test("a write that times out is re-checked against the list before reporting", async () => {
  const client = new FixtureSKaupatClient(fixtures);
  const list = await client.createList("t", "Testi", "fixture-store-1");
  const flaky: ShoppingListApi = {
    ...client,
    getLists: client.getLists.bind(client),
    getList: client.getList.bind(client),
    createList: client.createList.bind(client),
    removeItem: client.removeItem.bind(client),
    deleteList: client.deleteList.bind(client),
    // The write lands but the answer is lost.
    addItem: async (...args) => {
      await client.addItem(...args);
      throw new SKaupatError("unavailable", "timeout");
    },
  };
  const result = await addItemsToList({
    client,
    lists: flaky,
    withToken: (fn) => fn("t"),
    storeId: "fixture-store-1",
    list,
    items: [{ productId: MILK, quantity: 1, allowSubstitutes: true }],
  });
  assert.equal(result.results[0]?.status, "added");
  assert.equal(result.list.items.length, 1);
});

test("an expired login part-way reports the rest as missing", async () => {
  const client = new FixtureSKaupatClient(fixtures);
  const list = await client.createList("t", "Testi", "fixture-store-1");
  let writes = 0;
  const lists: ShoppingListApi = Object.assign(Object.create(client), {
    addItem: async (...args: Parameters<ShoppingListApi["addItem"]>) => {
      if (++writes > 1) throw new SKaupatError("session_expired", "expired");
      return client.addItem(...args);
    },
  });
  const result = await addItemsToList({
    client,
    lists,
    withToken: (fn) => fn("t"),
    storeId: "fixture-store-1",
    list,
    items: [MILK, BREAD, "0000000000048"].map((productId) => ({ productId, quantity: 1, allowSubstitutes: true })),
  });
  assert.deepEqual(
    result.results.map((r) => [r.status, r.status === "missing" ? r.error.code : null]),
    [
      ["added", null],
      ["missing", "session_expired"],
      ["missing", "session_expired"],
    ],
  );
});

function fakeFetch(responses: unknown[], seen: { headers: Record<string, string>; body: any }[] = [], status = 200) {
  return (async (_url: URL, init: RequestInit) => {
    seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(responses.shift()), { status });
  }) as unknown as typeof fetch;
}

const apiList = {
  id: "list-1",
  name: "Viikonloppu",
  createdAt: "2026-10-08T10:00:00.000Z",
  items: [
    {
      id: "item-1",
      ean: "6414893386488",
      sokId: "100296218",
      quantity: 2,
      isReplaceable: true,
      name: "Kotimaista kevytmaito 1 L",
      product: { ean: "6414893386488", name: "Kotimaista kevytmaito 1 L", price: 0.95, priceUnit: "KPL" },
    },
    {},
  ],
};

test("live list calls send the raw access token and map the list", async () => {
  const seen: { headers: Record<string, string>; body: any }[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch([{ data: { shoppingLists: [apiList] } }], seen) });
  const lists = await client.getLists("jwt-token", "517609418");
  assert.equal(seen[0]!.headers.authorization, "jwt-token");
  assert.match(seen[0]!.body.query, /shoppingLists \{ id name createdAt items \{ \.\.\. on ShoppingListItem/);
  assert.deepEqual(seen[0]!.body.variables, { storeId: "517609418" });
  assert.equal(lists[0]?.items.length, 1);
  const item = lists[0]!.items[0]!;
  assert.equal(item.productId, "6414893386488");
  assert.equal(item.quantity, 2);
  assert.equal(item.allowSubstitutes, true);
  assert.equal(item.product?.price, 0.95);
  assert.equal(item.product?.storeId, "517609418");
});

test("live list writes send ShoppingListItemInput as S-kaupat expects", async () => {
  const seen: { headers: Record<string, string>; body: any }[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch([{ data: { createShoppingListItem: apiList } }], seen) });
  const item = { ean: "6414893386488", sokId: "100296218", name: "Kotimaista kevytmaito 1 L", quantity: 2, isReplaceable: true };
  await client.addItem("jwt-token", "list-1", item, "517609418");
  assert.equal(seen[0]!.body.operationName, "RemoteAddToShoppingList");
  assert.deepEqual(seen[0]!.body.variables, { storeId: "517609418", shoppingListId: "list-1", item });
});

test("a rejected login on a list call is session_expired", async () => {
  const graphql = new HttpSKaupatClient({
    fetchImpl: fakeFetch([{ errors: [{ message: "no", extensions: { code: "UNAUTHENTICATED" } }], data: null }]),
  });
  await assert.rejects(graphql.getLists("old", "1"), (e: SKaupatError) => e.code === "session_expired");
  const http = new HttpSKaupatClient({ fetchImpl: fakeFetch([{}], [], 401) });
  await assert.rejects(http.getLists("old", "1"), (e: SKaupatError) => e.code === "session_expired");
});

test("an anonymous 401 is not mistaken for an expired login", async () => {
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch([{}], [], 401) });
  await assert.rejects(
    client.searchProducts({ storeId: "1", query: "a", limit: 1 }),
    (e: SKaupatError) => e.code === "upstream_error",
  );
});

test("listable products carry the sokId from the captured sample", async () => {
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch([docSample("availability-with-date.json")]) });
  const found = await client.getListableProducts("517609418", ["6414893386488", "6408430000432", "1"]);
  assert.equal(found.get("6414893386488")?.sokId, "100296218");
  assert.equal(found.get("6408430000432")?.product.name, "Valio Hyvä suomalainen Arki® rasvaton maitojuoma 1 l");
  assert.equal(found.has("1"), false);
});

test("the cart check maps the captured validateCart sample", async () => {
  const seen: { headers: Record<string, string>; body: any }[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch([docSample("validate-cart.json")], seen) });
  const checks = await client.checkBasket("517609418", [
    { id: "6414893386488", quantity: 2 },
    { id: "0000000000000", quantity: 1 },
  ]);
  assert.deepEqual(seen[0]!.body.variables.items, [
    { ean: "6414893386488", itemCount: "2" },
    { ean: "0000000000000", itemCount: "1" },
  ]);
  assert.equal(seen[0]!.headers.authorization, undefined);
  assert.equal(checks.get("6414893386488")?.status, "ok");
  assert.equal(checks.get("0000000000000")?.status, "not_found");
});

test("changing a quantity never takes the product off the list, even when a write fails", async () => {
  const client = new FixtureSKaupatClient(fixtures);
  let list = await client.createList("t", "Testi", "fixture-store-1");
  list = (await addItemsToList({
    client,
    lists: client,
    withToken: (fn) => fn("t"),
    storeId: "fixture-store-1",
    list,
    items: [{ productId: MILK, quantity: 1, allowSubstitutes: true }],
  })).list;
  const failing: ShoppingListApi = Object.assign(Object.create(client), {
    addItem: async () => {
      throw new SKaupatError("upstream_error", "down");
    },
  });
  const result = await addItemsToList({
    client,
    lists: failing,
    withToken: (fn) => fn("t"),
    storeId: "fixture-store-1",
    list,
    items: [{ productId: MILK, quantity: 4, allowSubstitutes: true }],
  });
  // The old row is still there with the old quantity, so the change is reported as uncertain, not done.
  assert.equal(result.results[0]?.status, "uncertain");
  assert.deepEqual(result.list.items.map((i) => [i.productId, i.quantity]), [[MILK, 1]]);
});

test("a new list is returned even if no product could be written", async () => {
  const client = new FixtureSKaupatClient(fixtures);
  const list = await client.createList("t", "Uusi", "fixture-store-1");
  const lists: ShoppingListApi = Object.assign(Object.create(client), {
    addItem: async () => {
      throw new SKaupatError("session_expired", "expired");
    },
  });
  const result = await addItemsToList({
    client,
    lists,
    withToken: (fn) => fn("t"),
    storeId: "fixture-store-1",
    list,
    newList: true,
    items: [{ productId: MILK, quantity: 1, allowSubstitutes: true }],
  });
  assert.equal(result.list.id, list.id);
  assert.equal(result.results[0]?.status, "missing");
});
