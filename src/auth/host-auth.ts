import { SKaupatError } from "../errors.js";
import type { HostPage } from "../host/host-page.js";
import { log } from "../log.js";
import { accountIdFor, type AuthApi } from "./auth-api.js";
import { findLogin } from "./find-login.js";
import { jwtExpiry } from "./session.js";
import type { LoginResult, LoginStatus, SKaupatAuth, StartLoginInput } from "./types.js";

/** An access token with less than this left is not used; the site is asked to renew it first. */
const RENEW_MARGIN_MS = 60_000;

export interface HostAuthOptions {
  page: HostPage;
  api: AuthApi;
  /** The page the user signs in on. */
  loginUrl?: string;
  now?: () => number;
  /** How often the host's storage is read while waiting. Default 1 s. */
  pollMs?: number;
  /** How long to wait for the site to renew its own login after a reload. Default 15 s. */
  renewWaitMs?: number;
}

/**
 * Login state for the host transport. The login is the one the user made on the S-kaupat site in
 * the host app's own page, so it lives in that page's localStorage and the site renews it itself.
 * The server never refreshes the login with the refresh token: S-kaupat may rotate that token on
 * each refresh, which would sign the host's page out. It only reads the access token the site
 * keeps, and when that is missing or about to expire it reloads the page and waits for the site to
 * write a new one. Tokens are never logged or stored by the server.
 */
export class HostAuth implements SKaupatAuth {
  private profile: { forRefreshToken: string; displayName: string | null; accountId: string | null } | null = null;
  private renewing: Promise<string> | null = null;
  private loginInProgress: Promise<LoginResult> | null = null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly renewWaitMs: number;

  constructor(private readonly options: HostAuthOptions) {
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 1000;
    this.renewWaitMs = options.renewWaitMs ?? 15_000;
  }

  async status(): Promise<LoginStatus> {
    const login = await this.read();
    if (!login) return { status: "logged_out", displayName: null, accountId: null };
    try {
      const { displayName, accountId } = await this.loadProfile(login.refreshToken);
      return { status: "logged_in", displayName, accountId };
    } catch (err) {
      if (err instanceof SKaupatError && err.code === "session_expired") return { status: "expired", displayName: null, accountId: null };
      if (err instanceof SKaupatError && err.code === "login_required") return { status: "logged_out", displayName: null, accountId: null };
      // A login the site still holds is a login; a temporary problem must not show the user as signed out.
      log.warn("Could not confirm the login in the app's page", { code: err instanceof SKaupatError ? err.code : "unknown" });
      const known = this.profile?.forRefreshToken === login.refreshToken ? this.profile : null;
      return { status: "logged_in", displayName: known?.displayName ?? null, accountId: known?.accountId ?? null };
    }
  }

  async startLogin({ timeoutSeconds }: StartLoginInput): Promise<LoginResult> {
    this.loginInProgress ??= this.runLogin(timeoutSeconds * 1000).finally(() => {
      this.loginInProgress = null;
    });
    return this.loginInProgress;
  }

  async getAccessToken(): Promise<string> {
    const login = await this.read();
    if (!login) throw new SKaupatError("login_required", "Not signed in to S-kaupat in the app.");
    if (this.usable(login.accessToken)) return login.accessToken;
    return this.renew(login.accessToken);
  }

  /** Runs an authenticated call; if S-kaupat rejects the token, the site renews it once and the call is retried. */
  async withAccessToken<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken();
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof SKaupatError && err.code === "session_expired")) throw err;
      return fn(await this.renew(token));
    }
  }

  async logout(options: { forgetLocal?: () => void } = {}): Promise<void> {
    if (this.loginInProgress) throw new SKaupatError("login_in_progress", "The S-kaupat sign-in is open.");
    await this.options.page.forget();
    options.forgetLocal?.();
    this.profile = null;
    log.info("Signed out of the app's S-kaupat page");
  }

  private async read() {
    const { entries } = await this.options.page.storage();
    return findLogin(entries);
  }

  /** A readable JWT with time left, or a token that cannot be read (the call itself will tell). */
  private usable(token: string | null): token is string {
    if (!token) return false;
    const exp = jwtExpiry(token);
    return exp === null || exp - RENEW_MARGIN_MS > this.now();
  }

  private renew(stale: string | null): Promise<string> {
    this.renewing ??= this.renewInPage(stale).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  /** The site renews its own login when it loads: reload it and wait for a token that differs from the old one. */
  private async renewInPage(stale: string | null): Promise<string> {
    await this.options.page.apiPage().reload();
    const deadline = this.now() + this.renewWaitMs;
    for (;;) {
      const login = await this.read();
      if (!login) throw new SKaupatError("login_required", "Not signed in to S-kaupat in the app.");
      if (this.usable(login.accessToken) && login.accessToken !== stale) return login.accessToken;
      if (this.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new SKaupatError("session_expired", "S-kaupat did not renew the login in the app's page.");
  }

  private async loadProfile(refreshToken: string): Promise<{ displayName: string | null; accountId: string | null }> {
    if (this.profile?.forRefreshToken === refreshToken) return this.profile;
    const profile = await this.withAccessToken((token) => this.options.api.userProfile(token));
    const displayName = profile.firstName?.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    const accountId = profile.userId ? accountIdFor(profile.userId) : null;
    this.profile = { forRefreshToken: refreshToken, displayName, accountId };
    return this.profile;
  }

  private async runLogin(timeoutMs: number): Promise<LoginResult> {
    const before = await this.status().catch(() => null);
    if (before?.status === "logged_in") {
      return { status: "logged_in", displayName: before.displayName, accountId: before.accountId, alreadyLoggedIn: true };
    }
    // An expired login stays in the page's storage until the user signs in again; wait for a different one.
    const rejected = before?.status === "expired" ? ((await this.read())?.refreshToken ?? null) : null;
    await this.options.page.open(this.options.loginUrl ?? "https://www.s-kaupat.fi/");
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const login = await this.read().catch(() => null);
      if (login && login.refreshToken !== rejected) {
        // Saved by the site. If only the name lookup fails, still report the sign-in.
        let displayName: string | null = null;
        let accountId: string | null = null;
        try {
          ({ displayName, accountId } = await this.loadProfile(login.refreshToken));
        } catch (err) {
          if (err instanceof SKaupatError && err.code === "session_expired") throw err;
          log.warn("Signed in, but the account name could not be fetched", { code: err instanceof SKaupatError ? err.code : "unknown" });
        }
        return { status: "logged_in", displayName, accountId, alreadyLoggedIn: false };
      }
      if (this.now() >= deadline) return { status: "timed_out", displayName: null, accountId: null, alreadyLoggedIn: false };
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }
}
