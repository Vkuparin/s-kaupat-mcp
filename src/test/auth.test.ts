import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HttpAuthApi, type AuthApi, type AuthTokens, type UserProfile } from "../auth/auth-api.js";
import { withFileLock } from "../auth/file-lock.js";
import { findLogin, type LoginWindow, type LoginWindowResult } from "../auth/login-window.js";
import { jwtExpiry, LiveAuth } from "../auth/session.js";
import { FileTokenStore, WindowsCredentialStore } from "../auth/token-store.js";
import { SKaupatError } from "../errors.js";

function jwt(expSeconds: number, extra: Record<string, unknown> = {}): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ exp: expSeconds, ...extra })}.sig`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

/**
 * Fake S-kaupat auth endpoint that rotates the refresh token on every renewal,
 * so using a refresh token twice fails, as a strict server would.
 */
class RotatingApi implements AuthApi {
  valid = "refresh-1";
  refreshCalls = 0;
  profileCalls = 0;
  rejectAccess = new Set<string>();
  private n = 1;

  async refresh(refreshToken: string): Promise<AuthTokens> {
    this.refreshCalls++;
    await new Promise((r) => setTimeout(r, 20));
    if (refreshToken !== this.valid) throw new SKaupatError("session_expired", "rejected");
    this.valid = `refresh-${++this.n}`;
    return { accessToken: jwt(inAnHour(), { n: this.n }), refreshToken: this.valid };
  }

  async userProfile(accessToken: string): Promise<UserProfile> {
    this.profileCalls++;
    if (this.rejectAccess.has(accessToken)) throw new SKaupatError("session_expired", "access rejected");
    return { firstName: "Ville", lastName: "Testinen" };
  }
}

class FakeWindow implements LoginWindow {
  opened = 0;
  stale: string[] = [];
  constructor(private readonly result: LoginWindowResult) {}
  async open(_timeoutMs: number, stale: string[] = []): Promise<LoginWindowResult> {
    this.opened++;
    this.stale = stale;
    await new Promise((r) => setTimeout(r, 20));
    return this.result;
  }
}

async function setup(initialToken: string | null, window: LoginWindow = new FakeWindow({ status: "cancelled" })) {
  const dir = await mkdtemp(join(tmpdir(), "skaupat-auth-"));
  const store = new FileTokenStore(join(dir, "refresh-token"));
  if (initialToken) await store.write(initialToken);
  const api = new RotatingApi();
  const make = () => new LiveAuth({ store, api, window, lockPath: join(dir, "refresh.lock") });
  return { dir, store, api, make, auth: make() };
}

test("no stored token reads as logged_out without any network call", async () => {
  const { auth, api } = await setup(null);
  assert.deepEqual(await auth.status(), { status: "logged_out", displayName: null });
  assert.equal(api.refreshCalls, 0);
});

test("stored token renews, saves the rotated refresh token and reports the first name", async () => {
  const { auth, api, store } = await setup("refresh-1");
  assert.deepEqual(await auth.status(), { status: "logged_in", displayName: "Ville" });
  assert.equal(await store.read(), api.valid);
  // Cached access token: no second renewal.
  await auth.getAccessToken();
  assert.equal(api.refreshCalls, 1);
});

test("rejected refresh reads as expired and is not retried on every check", async () => {
  const { auth, api } = await setup("refresh-old");
  assert.equal((await auth.status()).status, "expired");
  assert.equal((await auth.status()).status, "expired");
  assert.equal(api.refreshCalls, 1);
  await assert.rejects(auth.getAccessToken(), (e: SKaupatError) => e.code === "session_expired");
});

test("two server processes renewing at once don't log each other out", async () => {
  const { make, api } = await setup("refresh-1");
  // Separate instances share only the token store and lock file, like separate processes.
  const [a, b, c] = [make(), make(), make()];
  const tokens = await Promise.all([a.getAccessToken(), b.getAccessToken(), c.getAccessToken()]);
  assert.equal(tokens.length, 3);
  assert.equal(api.refreshCalls, 3);
});

test("concurrent calls in one process share a single renewal", async () => {
  const { auth, api } = await setup("refresh-1");
  await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.status()]);
  assert.equal(api.refreshCalls, 1);
});

test("an access token rejected early is renewed once and the call retried", async () => {
  const { auth, api } = await setup("refresh-1");
  const first = await auth.getAccessToken();
  api.rejectAccess.add(first);
  const result = await auth.withAccessToken((t) => api.userProfile(t));
  assert.equal(result.firstName, "Ville");
  assert.equal(api.refreshCalls, 2);
});

test("start_login stores only the refresh token and returns the name", async () => {
  const window = new FakeWindow({
    status: "logged_in",
    login: { refreshToken: "refresh-1", accessToken: jwt(inAnHour()) },
  });
  const { auth, store, api } = await setup(null, window);
  const result = await auth.startLogin({ timeoutSeconds: 60 });
  assert.deepEqual(result, { status: "logged_in", displayName: "Ville", alreadyLoggedIn: false });
  assert.equal(await store.read(), "refresh-1");
  // The captured access token was used directly, without renewing.
  assert.equal(api.refreshCalls, 0);
});

test("a second start_login while the window is open joins the first", async () => {
  const window = new FakeWindow({ status: "logged_in", login: { refreshToken: "refresh-1", accessToken: null } });
  const { auth } = await setup(null, window);
  await Promise.all([auth.startLogin({ timeoutSeconds: 60 }), auth.startLogin({ timeoutSeconds: 60 })]);
  assert.equal(window.opened, 1);
});

test("start_login when already logged in opens no window", async () => {
  const window = new FakeWindow({ status: "cancelled" });
  const { auth } = await setup("refresh-1", window);
  const result = await auth.startLogin({ timeoutSeconds: 60 });
  assert.equal(result.alreadyLoggedIn, true);
  assert.equal(window.opened, 0);
});

test("start_login after expiry replaces the rejected token", async () => {
  const window = new FakeWindow({ status: "logged_in", login: { refreshToken: "refresh-1", accessToken: null } });
  const { auth } = await setup("refresh-old", window);
  assert.equal((await auth.status()).status, "expired");
  assert.equal((await auth.startLogin({ timeoutSeconds: 60 })).status, "logged_in");
  assert.equal((await auth.status()).status, "logged_in");
  // The window profile may still hold the rejected token; the window is told to wait for a new one.
  assert.deepEqual(window.stale, ["refresh-old"]);
});

test("cancelled login stores nothing", async () => {
  const { auth, store } = await setup(null, new FakeWindow({ status: "cancelled" }));
  const result = await auth.startLogin({ timeoutSeconds: 60 });
  assert.equal(result.status, "cancelled");
  assert.equal(await store.read(), null);
});

test("jwtExpiry reads exp, and tolerates opaque tokens", () => {
  assert.equal(jwtExpiry(jwt(1000)), 1_000_000);
  assert.equal(jwtExpiry("opaque"), null);
});

test("file lock gives exclusive access and clears stale locks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skaupat-lock-"));
  const lock = join(dir, "x.lock");
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 5 }, () =>
      withFileLock(lock, async () => {
        maxInside = Math.max(maxInside, ++inside);
        await new Promise((r) => setTimeout(r, 10));
        inside--;
      }, { pollMs: 5 }),
    ),
  );
  assert.equal(maxInside, 1);

  await writeFile(lock, "99999");
  assert.equal(await withFileLock(lock, async () => "ok", { staleMs: -1 }), "ok");
});

test("token file is readable only by the user", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "skaupat-store-"));
  const store = new FileTokenStore(join(dir, "sub", "refresh-token"));
  await store.write("secret");
  assert.equal((await stat(join(dir, "sub", "refresh-token"))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(dir, "sub", "refresh-token"), "utf8"), "secret");
  await store.clear();
  assert.equal(await store.read(), null);
});

test("Credential Manager store never puts the token in the script", async () => {
  const calls: { script: string; stdin: string }[] = [];
  let saved = "";
  const store = new WindowsCredentialStore("t", async (script, stdin) => {
    calls.push({ script, stdin });
    if (script.includes("::Write(")) saved = stdin;
    if (script.includes("::Read(")) return saved;
    return "";
  });
  await store.write("the-secret-token");
  assert.equal(await store.read(), "the-secret-token");
  assert.ok(calls.every((c) => !c.script.includes("the-secret-token")));
  assert.equal(calls[0]!.stdin, Buffer.from("the-secret-token").toString("base64"));
});

test("findLogin finds tokens in nested and string-encoded storage", () => {
  assert.equal(findLogin([["a", "not json"], ["b", '{"refreshToken":null}']]), null);
  assert.deepEqual(findLogin([["session-storage", JSON.stringify({ state: { accessToken: "A", refreshToken: "R" } })]]), {
    accessToken: "A",
    refreshToken: "R",
  });
  const doubleEncoded = JSON.stringify({ apollo: JSON.stringify({ authenticationTokens: { refreshToken: "R2" } }) });
  assert.deepEqual(findLogin([["x", doubleEncoded]]), { accessToken: null, refreshToken: "R2" });
});

function fetchReturning(body: unknown, status = 200, seen: RequestInit[] = []): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    seen.push(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("auth API sends the raw access token and maps refresh results", async () => {
  const seen: RequestInit[] = [];
  const api = new HttpAuthApi({
    fetchImpl: fetchReturning({ data: { userProfile: { firstName: "Ville", lastName: null } } }, 200, seen),
  });
  assert.equal((await api.userProfile("jwt-value")).firstName, "Ville");
  assert.equal((seen[0]!.headers as Record<string, string>).authorization, "jwt-value");

  const refresh = new HttpAuthApi({
    fetchImpl: fetchReturning({ data: { authTokens: { accessToken: "a", idToken: "i", refreshToken: "r" } } }),
  });
  assert.deepEqual(await refresh.refresh("old"), { accessToken: "a", refreshToken: "r" });
});

test("auth API: refusal is session_expired, schema drift is upstream_error, 401 is session_expired", async () => {
  const refused = new HttpAuthApi({ fetchImpl: fetchReturning({ data: { authTokens: null }, errors: [{ message: "x" }] }) });
  await assert.rejects(refused.refresh("r"), (e: SKaupatError) => e.code === "session_expired");

  const drift = new HttpAuthApi({
    fetchImpl: fetchReturning({ errors: [{ message: "x", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] }, 400),
  });
  await assert.rejects(drift.refresh("r"), (e: SKaupatError) => e.code === "upstream_error");

  const unauthorized = new HttpAuthApi({ fetchImpl: fetchReturning({}, 401) });
  await assert.rejects(unauthorized.userProfile("t"), (e: SKaupatError) => e.code === "session_expired");

  const down = new HttpAuthApi({ fetchImpl: fetchReturning({}, 503) });
  await assert.rejects(down.refresh("r"), (e: SKaupatError) => e.code === "unavailable");
});

test("auth API errors never contain the token", async () => {
  const api = new HttpAuthApi({ fetchImpl: fetchReturning({ data: { authTokens: null } }) });
  await assert.rejects(api.refresh("super-secret-refresh"), (e: Error) => !e.message.includes("super-secret-refresh"));
});

test("start_login reports success when the login is saved but the name lookup is refused", async () => {
  const window = new FakeWindow({ status: "logged_in", login: { refreshToken: "refresh-1", accessToken: jwt(inAnHour()) } });
  const { auth, store, api } = await setup(null, window);
  api.userProfile = async () => {
    throw new SKaupatError("blocked", "S-kaupat refused the request (HTTP 403).");
  };
  const result = await auth.startLogin({ timeoutSeconds: 60 });
  assert.deepEqual(result, { status: "logged_in", displayName: null, alreadyLoggedIn: false });
  assert.equal(await store.read(), "refresh-1");
});

test("a temporary problem renewing a saved login does not read as logged out", async () => {
  const { auth, api } = await setup("refresh-1");
  api.refresh = async () => {
    throw new SKaupatError("unavailable", "S-kaupat did not respond in time.");
  };
  assert.equal((await auth.status()).status, "logged_in");
});
