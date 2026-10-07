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
}

export type LoginOutcome = "logged_in" | "cancelled" | "timed_out";

export interface LoginResult {
  status: LoginOutcome;
  displayName: string | null;
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
}
