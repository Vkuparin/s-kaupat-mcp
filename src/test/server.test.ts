import assert from "node:assert/strict";
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
import { createServer } from "../server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "catalogue.json");

async function connect(client = new FixtureSKaupatClient(fixtures), auth: SKaupatAuth = new FixtureAuth()) {
  const server = createServer(client, auth);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("lists the catalogue and login tools", async () => {
  const mcp = await connect();
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_products",
    "login_status",
    "search_products",
    "search_stores",
    "start_login",
  ]);
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

test("unknown store is a structured store_not_found error with user messages", async () => {
  const mcp = await connect();
  const { isError, data } = await call(mcp, "search_products", { storeId: "missing", query: "maito" });
  assert.equal(isError, true);
  assert.equal(data.error.code, "store_not_found");
  assert.equal(data.error.userMessage.fi, "Kauppaa ei löytynyt.");
  assert.equal(data.error.userMessage.en, "That store could not be found.");
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
});

test("start_login reports cancelled with a message to show", async () => {
  const auth: SKaupatAuth = {
    status: async () => ({ status: "logged_out", displayName: null }),
    startLogin: async () => ({ status: "cancelled", displayName: null, alreadyLoggedIn: false }),
    getAccessToken: async () => assert.fail(),
  };
  const mcp = await connect(undefined, auth);
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
  };
  const mcp = await connect(undefined, auth);
  const { isError, data } = await call(mcp, "start_login", {});
  assert.equal(isError, true);
  assert.equal(data.error.code, "login_window_unavailable");
  assert.equal(data.error.userMessage.fi, "Kirjautumisikkunaa ei voitu avata tällä laitteella.");
});
