import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { BrowserContext } from "playwright-core";
import { createBrowserFetch } from "../browser/browser-fetch.js";
import { browserArgs, launchProfile } from "../browser/launch.js";
import { type ApiPage, BrowserSession } from "../browser/session.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { SKaupatError } from "../errors.js";

type Result = { ok: true; status: number; contentType: string | null; body: string } | { ok: false; error: string };

/** A stand-in for the S-kaupat tab: records requests, answers from a script. */
function fakePage(answers: Result[]) {
  const requests: any[] = [];
  let reloads = 0;
  const page: ApiPage = {
    evaluate: async (_fn: any, arg: any) => {
      requests.push(arg);
      return answers.shift() as any;
    },
    reload: async () => {
      reloads++;
    },
  };
  return { page, requests, reloads: () => reloads };
}

const json = (body: unknown, status = 200): Result => ({
  ok: true,
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

test("browser fetch sends the request from the page and rebuilds the response", async () => {
  const { page, requests } = fakePage([json({ data: { x: 1 } })]);
  const fetchImpl = createBrowserFetch({ page: async () => page, minIntervalMs: 0 });
  const res = await fetchImpl(new URL("https://api.s-kaupat.fi/"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://x", Referer: "https://x/", authorization: "jwt" },
    body: '{"query":"{ a }"}',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: { x: 1 } });
  assert.equal(requests[0].url, "https://api.s-kaupat.fi/");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].body, '{"query":"{ a }"}');
  // The page sets Origin and Referer itself; the login token is passed on.
  assert.deepEqual(requests[0].headers, { "content-type": "application/json", authorization: "jwt" });
});

test("a refused call reloads the page once and retries", async () => {
  const { page, requests, reloads } = fakePage([json({}, 403), json({ data: {} })]);
  const res = await createBrowserFetch({ page: async () => page, minIntervalMs: 0 })("https://api/", {});
  assert.equal(res.status, 200);
  assert.equal(requests.length, 2);
  assert.equal(reloads(), 1);
});

test("refused twice ends as blocked", async () => {
  const twice403 = fakePage([json({}, 403), json({}, 403)]);
  const client = new HttpSKaupatClient({ fetchImpl: createBrowserFetch({ page: async () => twice403.page, minIntervalMs: 0 }) });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "blocked");

  const failed = fakePage([
    { ok: false, error: "TypeError: Failed to fetch" },
    { ok: false, error: "TypeError: Failed to fetch" },
  ]);
  await assert.rejects(
    createBrowserFetch({ page: async () => failed.page, minIntervalMs: 0 })("https://api/", {}),
    (e: SKaupatError) => e.code === "blocked",
  );
  assert.equal(failed.reloads(), 1);
});

test("a timeout is not retried and reads as unavailable", async () => {
  const { page, requests } = fakePage([{ ok: false, error: "timed out" }]);
  const client = new HttpSKaupatClient({ fetchImpl: createBrowserFetch({ page: async () => page, minIntervalMs: 0 }) });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "unavailable");
  assert.equal(requests.length, 1);
});

test("calls are spaced out, one at a time", async () => {
  const { page } = fakePage([json({}), json({}), json({})]);
  const fetchImpl = createBrowserFetch({ page: async () => page, minIntervalMs: 80 });
  const started = Date.now();
  await Promise.all([fetchImpl("https://api/", {}), fetchImpl("https://api/", {}), fetchImpl("https://api/", {})]);
  assert.ok(Date.now() - started >= 160, "three calls take at least two gaps");
});

/** A fake BrowserContext with just what BrowserSession uses. */
function fakeContext() {
  let closed = false;
  const listeners: (() => void)[] = [];
  const page = {
    isClosed: () => closed,
    goto: async () => null,
    evaluate: async () => null,
    reload: async () => null,
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    on: (event: string, fn: () => void) => event === "close" && listeners.push(fn),
    close: async () => {
      closed = true;
      listeners.forEach((fn) => fn());
    },
  };
  return { context: context as unknown as BrowserContext, isClosed: () => closed };
}

test("the browser starts on first use and API calls wait out the login window", async () => {
  const launched: ReturnType<typeof fakeContext>[] = [];
  const session = new BrowserSession({
    profileDir: "unused",
    launch: async () => {
      const c = fakeContext();
      launched.push(c);
      return c.context;
    },
  });
  assert.equal(launched.length, 0);
  await session.apiPage();
  await session.apiPage();
  assert.equal(launched.length, 1);

  let release!: () => void;
  const login = session.whileClosed(() => new Promise<string>((r) => (release = () => r("logged_in"))));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(launched[0]!.isClosed(), true, "the API browser closes so the login window can use the profile");
  await assert.rejects(session.apiPage(), (e: SKaupatError) => e.code === "login_in_progress");

  release();
  assert.equal(await login, "logged_in");
  await session.apiPage();
  assert.equal(launched.length, 2, "the next call starts the browser again");
  await session.close();
});

test("an idle browser closes itself", async () => {
  const c = fakeContext();
  const session = new BrowserSession({ profileDir: "unused", idleMs: 30, launch: async () => c.context });
  await session.apiPage();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.isClosed(), true);
});

// End to end with a real Chromium: a stand-in site on one port and a stand-in API on another, as
// www.s-kaupat.fi and api.s-kaupat.fi are. Skipped without a Chromium build.
const chromium = process.env.SKAUPAT_TEST_BROWSER ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = existsSync(chromium) ? false : `no Chromium at ${chromium}`;

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

test("a product search runs from inside the site's page, with the page's origin", { skip }, async () => {
  const sample = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "samples", "product-search.json"), "utf8"),
  ).response;
  const site = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>S-kaupat</p>");
  });
  const seen: { origin?: string; body: any }[] = [];
  const siteOrigin = site.url.slice(0, -1);
  const api = await listen((req, res) => {
    const cors = {
      "access-control-allow-origin": siteOrigin,
      "access-control-allow-headers": "content-type,authorization",
      "access-control-allow-methods": "POST, GET, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ origin: req.headers.origin, body: JSON.parse(body) });
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(sample));
    });
  });
  const profileDir = await mkdtemp(join(tmpdir(), "skaupat-browser-"));
  const session = new BrowserSession({
    profileDir,
    startUrl: site.url,
    launch: () =>
      launchProfile({
        profileDir,
        headless: true,
        executablePath: chromium,
        unavailableCode: "browser_unavailable",
        busyCode: "browser_busy",
      }),
  });
  try {
    const client = new HttpSKaupatClient({
      apiUrl: api.url,
      fetchImpl: createBrowserFetch({ page: () => session.apiPage(), minIntervalMs: 0 }),
    });
    const res = await client.searchProducts({ storeId: "517609418", query: "maito", limit: 3 });
    assert.equal(res.total, 1312);
    assert.equal(res.products[0]?.name, "Kotimaista kevytmaito 1 L");
    assert.equal(seen[0]?.origin, siteOrigin);
    assert.equal(seen[0]?.body.variables.queryString, "maito");
  } finally {
    await session.close();
    site.close();
    api.close();
  }
});

test("the browser does not hide that software drives it", () => {
  for (const minimized of [true, false]) {
    const args = browserArgs({ profileDir: "p", headless: false, minimized, unavailableCode: "browser_unavailable", busyCode: "browser_busy" });
    assert.ok(args.includes("--enable-automation"));
    assert.ok(!args.some((a) => /AutomationControlled|user-agent/i.test(a)));
  }
});

test("no network reads as unavailable, not blocked, and is not retried", async () => {
  const { page, requests, reloads } = fakePage([{ ok: false, error: "offline" }]);
  await assert.rejects(
    createBrowserFetch({ page: async () => page, minIntervalMs: 0 })("https://api/", {}),
    (e: SKaupatError) => e.code === "unavailable",
  );
  assert.equal(requests.length, 1);
  assert.equal(reloads(), 0);
});

test("a profile still held by a closing window is retried once", async () => {
  let attempts = 0;
  const c = fakeContext();
  const session = new BrowserSession({
    profileDir: "unused",
    busyRetryMs: 1,
    launch: async () => {
      if (++attempts === 1) throw new SKaupatError("browser_busy", "busy");
      return c.context;
    },
  });
  await session.apiPage();
  assert.equal(attempts, 2);
  await session.close();
});
