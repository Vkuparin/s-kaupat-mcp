import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigError, createRuntime, loadConfig } from "../lib.js";
import { HostAuth } from "../auth/host-auth.js";
import { HttpAuthApi } from "../auth/auth-api.js";
import { createBrowserFetch } from "../browser/browser-fetch.js";
import { HostPage } from "../host/host-page.js";
import { SKaupatError } from "../errors.js";

const KEY = "k".repeat(32);

function jwt(expSeconds: number): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds })}.sig`;
}
const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;
const storage = (accessToken: string | null, refreshToken = "refresh-1"): [string, string][] => [
  ["store-storage", JSON.stringify({ state: { storeId: "x" } })],
  ["session-storage", JSON.stringify({ state: { authTokens: { accessToken, refreshToken, idToken: "id" } }, version: 0 })],
];

/** A stand-in for the host app's S-kaupat page: the fixed protocol over local HTTP. */
class FakeHost {
  entries: [string, string][] = [];
  calls: { op: string; body: any; authorization: string | undefined }[] = [];
  /** What the page's own fetch answers, by GraphQL operation name in the query text. */
  api = (_body: any): { status: number; body: unknown } => ({ status: 200, body: { data: {} } });
  /** Called on reload: the site may renew its tokens by itself. */
  onReload: () => void = () => {};
  server!: Server;
  url!: string;

  async start() {
    this.server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const op = (req.url ?? "").split("/").pop()!;
      this.calls.push({ op, body, authorization: req.headers.authorization });
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { ok: false });
      if (op === "storage") return send(200, { ok: true, entries: this.entries, path: "/" });
      if (op === "reload") {
        this.onReload();
        return send(200, { ok: true });
      }
      if (op === "open" || op === "forget") {
        if (op === "forget") this.entries = [];
        return send(200, { ok: true });
      }
      if (op === "fetch") {
        const answer = this.api(body);
        return send(200, { ok: true, status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
      }
      send(404, { ok: false });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/s-kaupat`;
    return this;
  }
  stop() {
    this.server.close();
  }
}

const profile = (firstName = "Testi", userId = "user-1") => ({ data: { userProfile: { firstName, lastName: "X", userId } } });

function parts(host: FakeHost, options: Partial<ConstructorParameters<typeof HostAuth>[0]> = {}) {
  const page = new HostPage({ url: host.url, key: KEY });
  const fetchImpl = createBrowserFetch({ page: async () => page.apiPage(), minIntervalMs: 0 });
  const auth = new HostAuth({ page, api: new HttpAuthApi({ fetchImpl }), pollMs: 5, renewWaitMs: 200, ...options });
  return { page, fetchImpl, auth };
}

test("the host transport needs a loopback address and a long key", () => {
  const base = { SKAUPAT_TRANSPORT: "host" };
  assert.throws(() => loadConfig({ env: base }), ConfigError);
  assert.throws(() => loadConfig({ env: { ...base, SKAUPAT_HOST_URL: "http://127.0.0.1:8730/x", SKAUPAT_HOST_KEY: "short" } }), /at least 24/);
  for (const url of ["https://example.com/x", "http://192.168.1.5:8730/x", "http://127.0.0.1/x"]) {
    assert.throws(() => loadConfig({ env: { ...base, SKAUPAT_HOST_URL: url, SKAUPAT_HOST_KEY: KEY } }), /loopback|127\.0\.0\.1/);
  }
  const { config } = loadConfig({ env: { ...base, SKAUPAT_HOST_URL: "http://127.0.0.1:8730/s", SKAUPAT_HOST_KEY: KEY } });
  assert.equal(config.transport, "host");
  assert.equal(config.hostUrl, "http://127.0.0.1:8730/s");
  // The key is not a flag.
  assert.throws(() => loadConfig({ env: {}, argv: ["--host-key", KEY] }), ConfigError);
  // Demo mode needs no host.
  assert.equal(loadConfig({ env: base, argv: ["--demo"] }).config.mode, "demo");
});

test("a request is sent from the host's page with the key, and the answer is rebuilt", async () => {
  const host = await new FakeHost().start();
  try {
    host.api = () => ({ status: 200, body: { data: { ok: 1 } } });
    const { fetchImpl } = parts(host);
    const res = await fetchImpl("https://api.s-kaupat.fi/", { method: "POST", headers: { authorization: "jwt" }, body: "{}" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { ok: 1 } });
    const call = host.calls.find((c) => c.op === "fetch")!;
    assert.equal(call.authorization, `Bearer ${KEY}`);
    assert.equal(call.body.url, "https://api.s-kaupat.fi/");
    assert.equal(call.body.headers.authorization, "jwt");
    // A host that does not answer is "unavailable", never a login problem.
    host.stop();
    await assert.rejects(fetchImpl("https://api.s-kaupat.fi/"), (e: any) => e instanceof SKaupatError && e.code === "unavailable");
  } finally {
    host.stop();
  }
});

test("the login is the one in the host page's storage, and the account is a hash of the user ID", async () => {
  const host = await new FakeHost().start();
  try {
    const { auth } = parts(host);
    assert.equal((await auth.status()).status, "logged_out");

    const token = jwt(inHours(24 * 14));
    host.entries = storage(token);
    host.api = (body) => {
      assert.equal(body.headers.authorization, token, "the site sends the raw access token, as the site does");
      return { status: 200, body: profile() };
    };
    const status = await auth.status();
    assert.equal(status.status, "logged_in");
    assert.equal(status.displayName, "Testi");
    assert.match(status.accountId!, /^sk_[0-9a-f]{32}$/);
    assert.equal(await auth.getAccessToken(), token);
    // The name is looked up once per login, not on every status call.
    await auth.status();
    assert.equal(host.calls.filter((c) => c.op === "fetch").length, 1);
    // The server never uses the refresh token.
    assert.ok(!host.calls.some((c) => JSON.stringify(c.body).includes("refresh-1")));
  } finally {
    host.stop();
  }
});

test("an access token about to expire is renewed by the site: reload the page and wait for a new one", async () => {
  const host = await new FakeHost().start();
  try {
    const { auth } = parts(host);
    const old = jwt(inHours(0) + 10);
    const fresh = jwt(inHours(24 * 14));
    host.entries = storage(old);
    host.onReload = () => {
      setTimeout(() => (host.entries = storage(fresh)), 30);
    };
    assert.equal(await auth.getAccessToken(), fresh);
    assert.equal(host.calls.filter((c) => c.op === "reload").length, 1);

    // The site did not renew it in time: the login is expired, and nothing is refreshed on the server side.
    host.entries = storage(old);
    host.onReload = () => {};
    await assert.rejects(auth.getAccessToken(), (e: any) => e instanceof SKaupatError && e.code === "session_expired");
    assert.ok(!host.calls.some((c) => c.op === "fetch" && JSON.stringify(c.body).includes("refreshToken")));
  } finally {
    host.stop();
  }
});

test("a rejected token is renewed once by the site and the call is retried", async () => {
  const host = await new FakeHost().start();
  try {
    const first = jwt(inHours(48));
    const second = jwt(inHours(24 * 14));
    host.entries = storage(first);
    host.onReload = () => (host.entries = storage(second));
    host.api = (body) =>
      body.headers.authorization === first ? { status: 401, body: {} } : { status: 200, body: profile("Uusi", "user-2") };
    const { auth } = parts(host);
    const status = await auth.status();
    assert.equal(status.status, "logged_in");
    assert.equal(status.displayName, "Uusi");
  } finally {
    host.stop();
  }
});

test("signing in opens the host's page and waits for the site to save a login; logging out forgets it", async () => {
  const host = await new FakeHost().start();
  try {
    const { auth } = parts(host);
    // Nobody signs in: times out. A 30 s minimum for the tool is not enforced by the class itself.
    const timedOut = await auth.startLogin({ timeoutSeconds: 0.05 });
    assert.equal(timedOut.status, "timed_out");
    assert.ok(host.calls.some((c) => c.op === "open" && c.body.url === "https://www.s-kaupat.fi/"));

    host.api = () => ({ status: 200, body: profile() });
    setTimeout(() => (host.entries = storage(jwt(inHours(24 * 14)))), 40);
    const done = await auth.startLogin({ timeoutSeconds: 5 });
    assert.equal(done.status, "logged_in");
    assert.equal(done.displayName, "Testi");
    assert.equal(done.alreadyLoggedIn, false);
    assert.equal((await auth.startLogin({ timeoutSeconds: 5 })).alreadyLoggedIn, true);

    let forgotLocal = false;
    await auth.logout({ forgetLocal: () => (forgotLocal = true) });
    assert.ok(forgotLocal);
    assert.equal((await auth.status()).status, "logged_out");
  } finally {
    host.stop();
  }
});

test("a whole server runs on the host transport: login status and log out through MCP", async () => {
  const host = await new FakeHost().start();
  const dataDir = mkdtempSync(join(tmpdir(), "skaupat-host-"));
  const { config } = loadConfig({ env: { SKAUPAT_TRANSPORT: "host", SKAUPAT_HOST_URL: host.url, SKAUPAT_HOST_KEY: KEY }, argv: ["--data-dir", dataDir] });
  const runtime = createRuntime(config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "app", version: "1.0.0" });
  await Promise.all([runtime.createMcpServer().connect(b), client.connect(a)]);
  try {
    host.entries = storage(jwt(inHours(24 * 14)));
    host.api = () => ({ status: 200, body: profile("Ville") });
    const status = (await client.callTool({ name: "login_status", arguments: {} })).structuredContent as any;
    assert.equal(status.status, "logged_in");
    assert.equal(status.displayName, "Ville");
    assert.match(status.accountId, /^sk_/);

    // open_site shows the page in the host; the server does not fill in the host's storage.
    const opened = (await client.callTool({ name: "open_site", arguments: { applyChoice: true } })).structuredContent as any;
    assert.equal(opened.opened, true);
    assert.equal(opened.prefilled, false);
    assert.ok(host.calls.some((c) => c.op === "open"));

    await client.callTool({ name: "log_out", arguments: {} });
    assert.equal(host.entries.length, 0);
    const after = (await client.callTool({ name: "login_status", arguments: {} })).structuredContent as any;
    assert.equal(after.status, "logged_out");
  } finally {
    await runtime.close();
    host.stop();
  }
});
