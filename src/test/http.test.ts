import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ConfigError, createRuntime, loadConfig, startHttpServer } from "../lib.js";

const KEY = "test-access-key-0123456789abcdef";

async function start() {
  const dataDir = mkdtempSync(join(tmpdir(), "skaupat-http-"));
  const runtime = createRuntime(loadConfig({ env: {}, argv: ["--demo", "--data-dir", dataDir] }).config);
  const http = await startHttpServer(runtime, { host: "127.0.0.1", port: 0, accessKey: KEY });
  return { http, runtime };
}

async function connect(url: string, key = KEY) {
  const client = new Client({ name: "app", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${key}` } } }),
  );
  return client;
}

function rawPost(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

test("an app can use the server over local HTTP with its access key; state carries over between requests", async () => {
  const { http, runtime } = await start();
  try {
    const client = await connect(http.url);
    await client.callTool({ name: "select_store", arguments: { storeId: "fixture-store-1" } });
    const again = await connect(http.url);
    const status = (await again.callTool({ name: "get_setup_status", arguments: {} })).structuredContent as any;
    assert.equal(status.store.id, "fixture-store-1");
    await client.close();
    await again.close();
  } finally {
    await http.close();
    await runtime.close();
  }
});

test("an order reviewed in one HTTP request can be placed in the next", async () => {
  const { http, runtime } = await start();
  const data = (r: any) => r.structuredContent as any;
  try {
    const client = await connect(http.url);
    await client.callTool({ name: "select_store", arguments: { storeId: "fixture-store-1" } });
    await client.callTool({ name: "start_login", arguments: {} });
    const area = "demo-pickup-fixture-store-1";
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const slots = data(await client.callTool({ name: "get_delivery_slots", arguments: { areaId: area, fromDate: tomorrow, days: 1 } }));
    const slot = slots.days[0].slots.find((s: any) => s.status === "available");
    await client.callTool({ name: "select_delivery", arguments: { areaId: area, slotId: slot.slotId } });
    const draft = { items: [{ productId: "0000000000017", quantity: 1 }], payment: { method: "card", cardId: "demo-card-1" } };
    const review = data(await client.callTool({ name: "review_order", arguments: draft }));
    assert.ok(review.confirmationCode, JSON.stringify(review));
    // The Order press arrives as a separate request, which the server answers with a new MCP server.
    const placed = await client.callTool({ name: "place_order", arguments: { ...draft, confirmationCode: review.confirmationCode, paymentPage: "later" } });
    assert.equal(placed.isError, undefined, JSON.stringify(placed.structuredContent));
    assert.ok(data(placed).order.orderId);
    await client.close();
  } finally {
    await http.close();
    await runtime.close();
  }
});

test("requests without the key, for another host or from a web page are refused", async () => {
  const { http, runtime } = await start();
  try {
    assert.equal(await rawPost(http.url, {}), 401);
    assert.equal(await rawPost(http.url, { authorization: "Bearer wrong" }), 401);
    assert.equal(await rawPost(http.url, { authorization: `Bearer ${KEY}`, host: "evil.example" }), 403);
    assert.equal(await rawPost(http.url, { authorization: `Bearer ${KEY}`, origin: "https://evil.example" }), 403);
    await assert.rejects(connect(http.url, "nope-nope-nope-nope-nope-nope"));
  } finally {
    await http.close();
    await runtime.close();
  }
});

test("HTTP needs a long enough access key, from the environment or config file", () => {
  assert.throws(() => loadConfig({ env: {}, argv: ["--http-port", "8717"] }), ConfigError);
  assert.throws(() => loadConfig({ env: { SKAUPAT_ACCESS_KEY: "short" }, argv: ["--http-port", "8717"] }), ConfigError);
  const { config } = loadConfig({ env: { SKAUPAT_ACCESS_KEY: KEY }, argv: ["--http-port", "8717"] });
  assert.deepEqual([config.httpPort, config.httpHost], [8717, "127.0.0.1"]);
});
