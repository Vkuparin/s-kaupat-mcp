import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { SKaupatError } from "../errors.js";
import { log } from "../log.js";
import { accountIdFor, type AuthApi } from "./auth-api.js";
import { withFileLock } from "./file-lock.js";
import type { LoginWindow } from "./login-window.js";
import type { TokenStore } from "./token-store.js";
import type { LoginResult, LoginStatus, SKaupatAuth, StartLoginInput } from "./types.js";

/** Renew this long before the access token expires. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** Assumed lifetime when an access token's expiry can't be read. */
const FALLBACK_LIFETIME_MS = 60 * 60_000;
/** setTimeout's ceiling; longer timers fire immediately. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface LiveAuthOptions {
  store: TokenStore;
  api: AuthApi;
  window: LoginWindow;
  /** Lock file shared by every server process that uses the same token store. */
  lockPath: string;
  now?: () => number;
  /** Renew quietly in the background before the access token expires. Off in tests. */
  backgroundRenewal?: boolean;
  /** Clears the S-kaupat session in the server's browser profile (storage and cookies). */
  forgetSiteSession?: () => Promise<void>;
}

interface AccessToken {
  token: string;
  expiresAt: number;
}

/**
 * Login state for the live server. Keeps only the refresh token on disk (in
 * the TokenStore) and the access token in memory, and renews quietly.
 *
 * Renewal runs under a cross-process file lock, and re-reads the stored
 * refresh token after taking it: if another process already renewed and
 * S-kaupat rotated the refresh token, this process uses the new one instead
 * of the one it read earlier, so caller apps never log each other out.
 */
export class LiveAuth implements SKaupatAuth {
  private access: AccessToken | null = null;
  private displayName: string | null = null;
  private accountId: string | null = null;
  /** The stored refresh token S-kaupat last rejected; avoids retrying it on every status check. */
  private rejected: string | null = null;
  private renewing: Promise<string> | null = null;
  private loginInProgress: Promise<LoginResult> | null = null;
  private loggingOut: Promise<void> | null = null;
  /** Logins this process logged out of; the site's storage must not hand them back to a new login. */
  private readonly forgotten = new Set<string>();
  /** The login generation the cached access token and name belong to (see sessionFile). */
  private generation: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly options: LiveAuthOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * A small file next to the lock that changes on every login and log out. Other server processes
   * sharing the login compare it before using a cached access token, so after one app switches
   * account the others stop acting on the old one.
   */
  private get sessionFile(): string {
    return `${this.options.lockPath}.session`;
  }

  private async readGeneration(): Promise<string> {
    return readFile(this.sessionFile, "utf8").catch(() => "");
  }

  private async newGeneration(): Promise<void> {
    const id = randomUUID();
    await writeFile(this.sessionFile, id).catch((err: unknown) => {
      log.warn("Could not record the login change", { code: (err as NodeJS.ErrnoException).code ?? "unknown" });
    });
    this.generation = id;
  }

  /** Drops the cached token and name when another process logged in or out since they were read. */
  private async dropIfStale(): Promise<void> {
    if (!this.access && !this.displayName) return;
    if ((await this.readGeneration()) !== (this.generation ?? "")) {
      this.access = null;
      this.displayName = null;
      this.accountId = null;
    }
  }

  async status(): Promise<LoginStatus> {
    await this.loggingOut?.catch(() => {});
    const stored = await this.options.store.read();
    if (!stored) return { status: "logged_out", displayName: null, accountId: null };
    if (stored === this.rejected) return { status: "expired", displayName: null, accountId: null };
    try {
      const displayName = await this.loadDisplayName();
      return { status: "logged_in", displayName, accountId: this.accountId };
    } catch (err) {
      if (err instanceof SKaupatError && err.code === "session_expired") return { status: "expired", displayName: null, accountId: null };
      if (err instanceof SKaupatError && err.code === "login_required") return { status: "logged_out", displayName: null, accountId: null };
      // A saved login that S-kaupat has not rejected is still a login; a temporary problem (S-kaupat
      // busy, browser not available) must not make the app show the user as logged out.
      log.warn("Could not confirm the saved login", { code: err instanceof SKaupatError ? err.code : "unknown" });
      return { status: "logged_in", displayName: this.displayName, accountId: this.accountId };
    }
  }

  async startLogin({ timeoutSeconds }: StartLoginInput): Promise<LoginResult> {
    await this.loggingOut?.catch(() => {});
    // A second button press while the window is open joins the same login instead of opening another window.
    this.loginInProgress ??= this.runLogin(timeoutSeconds * 1000).finally(() => {
      this.loginInProgress = null;
    });
    return this.loginInProgress;
  }

  async getAccessToken(): Promise<string> {
    await this.dropIfStale();
    if (this.access && this.access.expiresAt - RENEW_MARGIN_MS > this.now()) return this.access.token;
    return this.renew();
  }

  async logout(options: { forgetLocal?: () => void } = {}): Promise<void> {
    if (this.loginInProgress) throw new SKaupatError("login_in_progress", "The S-kaupat login window is open.");
    this.loggingOut ??= this.runLogout(options).finally(() => {
      this.loggingOut = null;
    });
    return this.loggingOut;
  }

  private async runLogout({ forgetLocal }: { forgetLocal?: () => void }): Promise<void> {
    await this.renewing?.catch(() => {});
    await withFileLock(this.options.lockPath, async () => {
      const stored = await this.options.store.read();
      if (stored) this.forgotten.add(stored);
      await this.options.store.clear();
    });
    await this.newGeneration();
    forgetLocal?.();
    this.close();
    this.access = null;
    this.displayName = null;
    this.accountId = null;
    this.rejected = null;
    // The profile still holds the site's tokens and sign-in cookies; without clearing them the next
    // login window would pick the same account up again without asking.
    await this.options.forgetSiteSession?.();
    log.info("Logged out on this machine");
  }

  /** Stops the background renewal timer. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async runLogin(timeoutMs: number): Promise<LoginResult> {
    const current = await this.status().catch(() => null);
    if (current?.status === "logged_in") {
      return { status: "logged_in", displayName: current.displayName, accountId: current.accountId, alreadyLoggedIn: true };
    }

    // The login window's profile keeps the site's storage between runs, so it may still hold the
    // token S-kaupat just rejected. Tell the window to wait for a different one.
    const stale = current?.status === "expired" ? await this.options.store.read() : null;
    const result = await this.options.window.open(timeoutMs, [...this.forgotten, ...(stale ? [stale] : [])]);
    if (result.status !== "logged_in") {
      log.info("Login window closed without a login", { outcome: result.status });
      return { status: result.status, displayName: null, accountId: null, alreadyLoggedIn: false };
    }

    await withFileLock(this.options.lockPath, () => this.options.store.write(result.login.refreshToken));
    await this.newGeneration();
    this.rejected = null;
    this.displayName = null;
    this.accountId = null;
    this.access = result.login.accessToken ? this.toAccess(result.login.accessToken) : null;
    log.info("Login saved", { store: this.options.store.description });

    // The login is saved at this point. If only the name lookup fails (S-kaupat busy or refusing
    // the request), still report success rather than telling the user their login failed.
    let displayName: string | null = null;
    try {
      displayName = await this.loadDisplayName();
    } catch (err) {
      if (err instanceof SKaupatError && err.code === "session_expired") throw err;
      log.warn("Login saved, but the account name could not be fetched", {
        code: err instanceof SKaupatError ? err.code : "unknown",
      });
    }
    return { status: "logged_in", displayName, accountId: this.accountId, alreadyLoggedIn: false };
  }

  /** Fetches the account's name, renewing the access token once if S-kaupat rejects it. */
  private async loadDisplayName(): Promise<string | null> {
    await this.dropIfStale();
    if (this.displayName && this.access && this.access.expiresAt > this.now()) return this.displayName;
    const profile = await this.withAccessToken((token) => this.options.api.userProfile(token));
    this.displayName = profile.firstName?.trim() || [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    this.accountId = profile.userId ? accountIdFor(profile.userId) : null;
    return this.displayName;
  }

  /**
   * Runs an authenticated call. On session_expired it renews once and retries,
   * because an access token can be revoked before its stated expiry.
   */
  async withAccessToken<T>(fn: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.getAccessToken();
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof SKaupatError && err.code === "session_expired")) throw err;
      this.access = null;
      return fn(await this.renew());
    }
  }

  private renew(): Promise<string> {
    this.renewing ??= withFileLock(this.options.lockPath, () => this.renewLocked()).finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  private async renewLocked(): Promise<string> {
    // Read inside the lock: another process may have just rotated the token.
    const stored = await this.options.store.read();
    if (!stored) {
      this.access = null;
      throw new SKaupatError("login_required", "No stored S-kaupat login.");
    }
    if (stored === this.rejected) {
      throw new SKaupatError("session_expired", "The stored S-kaupat login was already rejected.");
    }
    try {
      const generation = await this.readGeneration();
      const tokens = await this.options.api.refresh(stored);
      if (tokens.refreshToken && tokens.refreshToken !== stored) await this.options.store.write(tokens.refreshToken);
      this.access = this.toAccess(tokens.accessToken);
      this.generation = generation;
      this.scheduleRenewal();
      log.debug("Access token renewed");
      return this.access.token;
    } catch (err) {
      if (err instanceof SKaupatError && err.code === "session_expired") {
        // Keep the stored token so status reads "expired" rather than "logged out"; a new login replaces it.
        this.rejected = stored;
        this.access = null;
        this.displayName = null;
        this.accountId = null;
      }
      throw err;
    }
  }

  private toAccess(token: string): AccessToken {
    return { token, expiresAt: jwtExpiry(token) ?? this.now() + FALLBACK_LIFETIME_MS };
  }

  private scheduleRenewal(): void {
    if (!this.options.backgroundRenewal || !this.access) return;
    this.close();
    const delay = Math.min(Math.max(this.access.expiresAt - RENEW_MARGIN_MS - this.now(), 60_000), MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.access = null;
      this.renew().catch((err) => {
        log.warn("Background login renewal failed", { code: err instanceof SKaupatError ? err.code : "unknown" });
      });
    }, delay);
    // Never keep the process alive just to renew.
    this.timer.unref();
  }
}

/** Reads `exp` from a JWT without verifying it; null if the token isn't a readable JWT. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
