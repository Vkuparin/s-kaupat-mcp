/**
 * Caller-facing login state. See docs/s-kaupat-api.md section 5b.
 *
 * - logged_out: no stored login on this machine.
 * - logged_in: a stored login that S-kaupat currently accepts.
 * - expired: a stored login that S-kaupat rejected; the user must log in again.
 */
export type LoginState = "logged_in" | "logged_out" | "expired";

export interface LoginStatus {
  status: LoginState;
  /** The account holder's first name (or full name) when logged in. */
  displayName: string | null;
  /**
   * A stable ID for the S-kaupat account when logged in: the same account always gets the same ID,
   * on any device and across logins, and a different account a different one. Derived one-way from
   * S-kaupat's own user ID, which is never returned. null when logged out or not yet known.
   */
  accountId: string | null;
}

export type LoginOutcome = "logged_in" | "cancelled" | "timed_out";

export interface LoginResult {
  status: LoginOutcome;
  displayName: string | null;
  /** As in LoginStatus. */
  accountId: string | null;
  /** True when the user was already logged in and no window was opened. */
  alreadyLoggedIn: boolean;
}

export interface StartLoginInput {
  timeoutSeconds: number;
}

/** What the MCP layer needs from the login implementation. */
export interface SKaupatAuth {
  /** Reports login state. Never opens a window. */
  status(): Promise<LoginStatus>;
  /** Opens the server's own login window and waits until the user finishes, cancels or times out. */
  startLogin(input: StartLoginInput): Promise<LoginResult>;
  /** A valid access token for authenticated calls; renews quietly. Throws login_required or session_expired. */
  getAccessToken(): Promise<string>;
  /**
   * Runs an authenticated call, renewing the access token once and retrying if
   * S-kaupat rejects it. Optional; callers fall back to getAccessToken.
   */
  withAccessToken?<T>(fn: (accessToken: string) => Promise<T>): Promise<T>;
  /**
   * Forgets the login on this machine: the stored login and the S-kaupat session in the server's own
   * browser profile, so the next login asks for the account again. Nothing changes on S-kaupat.
   */
  logout(options?: { forgetLocal?: () => void }): Promise<void>;
}
