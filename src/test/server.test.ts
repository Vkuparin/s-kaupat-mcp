import { DemoCheckout } from "../demo/checkout.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureAuth } from "../auth/fixture-auth.js";
import type { SKaupatAuth } from "../auth/types.js";
import { SKaupatError } from "../errors.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { FileStoreSelection, type StoreSelection } from "../selection.js";
import { createServer, SERVER_VERSION } from "../server.js";
import type { SKaupatClient } from "../client/types.js";
import type { ShoppingListApi } from "../lists/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function connect(
  client: SKaupatClient = new FixtureSKaupatClient(),
  {
    selection,
    auth = new FixtureAuth(),
    lists = client instanceof FixtureSKaupatClient ? client : undefined,
    now,
  }: { selection?: StoreSelection; auth?: SKaupatAuth; lists?: ShoppingListApi; now?: () => Date } = {},
) {
  const delivery = client instanceof FixtureSKaupatClient ? client : undefined;
  const checkout = delivery ? new DemoCheckout() : undefined;
  const server = createServer(client, auth, { selection, lists, delivery, now, checkout });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("lists the catalogue, store, login, shopping list, delivery and checkout tools", async () => {
  const mcp = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "add_to_shopping_list",
    "browse_category",
    "cancel_order",
    "check_basket",
    "clear_delivery",
    "confirm_payment",
    "create_shopping_list",
    "delete_shopping_list",
    "find_address",
    "get_checkout_options",
    "get_delivery_options",
    "get_delivery_slots",
    "get_order",
    "get_order_items",
    "get_orders",
    "get_product_details",
    "get_products",
    "get_selected_store",
    "get_setup_status",
    "get_shopping_list",
    "get_shopping_lists",
    "get_site_choice",
    "list_categories",
    "log_out",
    "login_status",
    "open_site",
    "pay_order",
    "place_order",
    "remove_from_shopping_list",
    "review_order",
    "search_products",
    "search_stores",
    "select_delivery",
    "select_store",
    "start_login",
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
  assert.equal(data.error.userMessage.fi, "Valitse ensin kauppa.");
  assert.equal(data.error.userMessage.en, "Please choose a store first.");
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
  const first = await connect(undefined, { selection: new FileStoreSelection(path) });
  await call(first, "select_store", { storeId: "fixture-store-3" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).selectedStore.id, "fixture-store-3");

  const second = await connect(undefined, { selection: new FileStoreSelection(path) });
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

test("unknown store is a structured store_not_found error with user messages", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_products", { storeId: "missing", query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "store_not_found");
  assert.equal(data.error.userMessage.fi, "Kauppaa ei löytynyt. Valitse kauppa uudelleen.");
  assert.equal(data.error.userMessage.en, "That store could not be found. Please choose your store again.");
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

test("fixture login: logged out, then start_login, then logged in", async () => {
  const mcp = await connect();
  assert.equal((await call(mcp, "login_status", {})).data.status, "logged_out");
  const login = await call(mcp, "start_login", {});
  assert.equal(login.isError, false);
  assert.equal(login.data.status, "logged_in");
  assert.equal(login.data.alreadyLoggedIn, false);
  assert.ok(login.data.userMessage.fi && login.data.userMessage.en);
  const status = await call(mcp, "login_status", {});
  assert.deepEqual([status.data.status, status.data.displayName], ["logged_in", "Testi"]);
  assert.match(status.data.accountId, /^sk_[0-9a-f]{32}$/);
  const setup = await call(mcp, "get_setup_status", {});
  assert.equal(setup.data.login.accountId, status.data.accountId);
});

test("start_login reports cancelled with a message to show", async () => {
  const auth: SKaupatAuth = {
    status: async () => ({ status: "logged_out", displayName: null, accountId: null }),
    startLogin: async () => ({ status: "cancelled", displayName: null, accountId: null, alreadyLoggedIn: false }),
    getAccessToken: async () => assert.fail(),
    logout: async () => {},
  };
  const mcp = await connect(undefined, { auth });
  const { isError, data } = await call(mcp, "start_login", { timeoutSeconds: 60 });
  assert.equal(isError, false);
  assert.equal(data.status, "cancelled");
  assert.equal(data.userMessage.en, "Login was cancelled.");
});

test("auth errors reach the caller with code and Finnish and English messages", async () => {
  const auth: SKaupatAuth = {
    status: async () => {
      throw new SKaupatError("login_window_unavailable", "no browser");
    },
    startLogin: async () => {
      throw new SKaupatError("login_window_unavailable", "no browser");
    },
    getAccessToken: async () => assert.fail(),
  logout: async () => {},
  };
  const mcp = await connect(undefined, { auth });
  const { isError, data } = await call(mcp, "start_login", {});
  assert.equal(isError, true);
  assert.equal(data.error.code, "login_window_unavailable");
  assert.equal(data.error.userMessage.fi, "Kirjautumisikkunaa ei voitu avata tällä laitteella.");
});

test("get_product_details returns allergens and nutrition", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "get_product_details", { storeId: "fixture-store-1", productId: "0000000000017" });
  assert.equal(isError, false);
  assert.equal(data.product.name, "Kevytmaito 1 l");
  assert.equal(data.product.price, 1.09);
  assert.deepEqual(data.product.allergens[0], { code: "AM", name: "Maito", level: "contains" });
  assert.equal(data.product.nutrients[0].kcal, 47);
  const bread = await call(mcp, "get_product_details", { storeId: "fixture-store-1", productId: "0000000000024" });
  assert.deepEqual(bread.data.product.allergens, []);
  assert.equal(bread.data.product.ingredients, null);
});

test("get_product_details of an unknown product is product_unavailable", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "get_product_details", { storeId: "fixture-store-1", productId: "nope" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "product_unavailable");
  assert.equal(data.error.productId, "nope");
});

test("list_categories walks the tree level by level", async () => {
  const mcp = await connect();
  const top = await call(mcp, "list_categories", { storeId: "fixture-store-1" });
  assert.equal(top.data.parent, null);
  assert.deepEqual(
    top.data.categories.map((c: any) => [c.slug, c.childCount, c.children]),
    [
      ["maito-munat-ja-rasvat", 2, undefined],
      ["leivat-keksit-ja-leivonnaiset", 1, undefined],
      ["hedelmat-ja-vihannekset", 1, undefined],
    ],
  );
  const dairy = await call(mcp, "list_categories", { storeId: "fixture-store-1", parent: "maito-munat-ja-rasvat", depth: 2 });
  assert.equal(dairy.data.parent.name, "Maito, munat ja rasvat");
  assert.equal(dairy.data.categories[0].children[0].slug, "maito-munat-ja-rasvat/maidot-ja-piimat/maidot");
  const bad = await call(mcp, "list_categories", { storeId: "fixture-store-1", parent: "nope" });
  assert.equal(bad.data.error.code, "invalid_argument");
});

test("browse_category pages through a category, cheapest first", async () => {
  const mcp = await connect();
  const { data } = await call(mcp, "browse_category", {
    storeId: "fixture-store-1",
    slug: "maito-munat-ja-rasvat",
    sort: "price_asc",
    limit: 2,
  });
  assert.equal(data.total, 3);
  assert.deepEqual(data.products.map((p: any) => p.price), [0.69, 1.09]);
  const next = await call(mcp, "browse_category", { storeId: "fixture-store-1", slug: "maito-munat-ja-rasvat", sort: "price_asc", limit: 2, offset: 2 });
  assert.deepEqual(next.data.products.map((p: any) => p.price), [1.39]);
});

test("the Claude Desktop extension manifest lists exactly the server's tools", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const { tools } = await (await connect()).listTools();
  assert.deepEqual(manifest.tools.map((t: any) => t.name).sort(), tools.map((t) => t.name).sort());
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.version, SERVER_VERSION);
});

test("get_setup_status walks an app through first run: store, then login, then ready", async () => {
  const mcp = await connect();
  let { data } = await call(mcp, "get_setup_status", {});
  assert.equal(data.mode, "live");
  assert.equal(data.store, null);
  assert.equal(data.nextStep, "choose_store");
  assert.equal(data.canSearch, false);

  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  ({ data } = await call(mcp, "get_setup_status", {}));
  assert.equal(data.store.id, "fixture-store-1");
  assert.deepEqual([data.canSearch, data.canUseLists, data.nextStep], [true, false, "log_in"]);

  await call(mcp, "start_login", {});
  ({ data } = await call(mcp, "get_setup_status", {}));
  assert.deepEqual([data.login.status, data.canUseLists, data.nextStep], ["logged_in", true, null]);
});

test("get_setup_status still answers when the login check fails", async () => {
  const auth = new FixtureAuth();
  auth.status = async () => {
    throw new SKaupatError("unavailable", "down");
  };
  const { isError, data } = await call(await connect(undefined, { auth }), "get_setup_status", {});
  assert.equal(isError, false);
  assert.equal(data.login.status, "unknown");
  assert.equal(data.nextStep, "choose_store");
});

test("every error tells the app what to offer next", async () => {
  const { data } = await call(await connect(), "search_products", { query: "maito" });
  assert.equal(data.error.code, "store_not_selected");
  assert.equal(data.error.action, "choose_store");
  assert.equal(data.error.retryable, false);
});

test("the server tells the model the intended flow", async () => {
  const mcp = await connect();
  const instructions = mcp.getInstructions() ?? "";
  assert.match(instructions, /get_setup_status/);
  assert.match(instructions, /never on your own/);
});
