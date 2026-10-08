import { SKaupatError } from "../errors.js";
import { accountIdFor } from "./auth-api.js";
import type { LoginResult, LoginStatus, SKaupatAuth } from "./types.js";

/** The demo account's ID, the same on every run. */
export const DEMO_ACCOUNT_ID = accountIdFor("demo");

/**
 * Pretend login for SKAUPAT_MODE=fixtures, so caller apps can build and test
 * their login button and status display without S-kaupat. start_login
 * succeeds at once, without opening a window.
 */
export class FixtureAuth implements SKaupatAuth {
  private loggedIn = false;

  constructor(private readonly displayName = "Testi") {}

  async status(): Promise<LoginStatus> {
    return this.loggedIn
      ? { status: "logged_in", displayName: this.displayName, accountId: DEMO_ACCOUNT_ID }
      : { status: "logged_out", displayName: null, accountId: null };
  }

  async startLogin(): Promise<LoginResult> {
    const alreadyLoggedIn = this.loggedIn;
    this.loggedIn = true;
    return { status: "logged_in", displayName: this.displayName, accountId: DEMO_ACCOUNT_ID, alreadyLoggedIn };
  }

  async logout(options: { forgetLocal?: () => void } = {}): Promise<void> {
    options.forgetLocal?.();
    this.loggedIn = false;
  }

  async getAccessToken(): Promise<string> {
    if (!this.loggedIn) throw new SKaupatError("login_required", "Not logged in (fixture mode).");
    return "fixture-access-token";
  }
}
