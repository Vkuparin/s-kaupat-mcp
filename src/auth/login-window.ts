import { SKaupatError } from "../errors.js";
import { log } from "../log.js";

/**
 * The server's own small S-kaupat login window. It runs in a browser profile
 * that belongs to this server (never the user's everyday browser profile), so
 * the only login it can see is the one the user makes in it.
 *
 * After the user logs in, the site keeps its tokens in the page's
 * localStorage. The window watches that storage, takes the refresh token (and
 * the access token when present), and closes. Tokens are never logged.
 *
 * UNVERIFIED against the live site: the exact localStorage keys, and where
 * the site's login button lives. The token search below is deliberately
 * shape-agnostic: it looks for any object with a non-empty `refreshToken`.
 */

export interface CapturedLogin {
  refreshToken: string;
  accessToken: string | null;
}

export type LoginWindowResult =
  | { status: "logged_in"; login: CapturedLogin }
  | { status: "cancelled" }
  | { status: "timed_out" };

export interface LoginWindow {
  open(timeoutMs: number): Promise<LoginWindowResult>;
}

export interface BrowserLoginWindowOptions {
  /** The window's own browser profile folder. */
  profileDir: string;
  startUrl?: string;
  /** A Chromium-based browser to use instead of the installed Edge or Chrome. */
  executablePath?: string;
  headless?: boolean;
  pollMs?: number;
}

export class BrowserLoginWindow implements LoginWindow {
  constructor(private readonly options: BrowserLoginWindowOptions) {}

  async open(timeoutMs: number): Promise<LoginWindowResult> {
    const startUrl = this.options.startUrl ?? "https://www.s-kaupat.fi/";
    const origin = new URL(startUrl).origin;
    const context = await this.launch();
    let closed = false;
    context.on("close", () => {
      closed = true;
    });

    try {
      const page = context.pages()[0] ?? (await context.newPage());
      // A failed load is shown to the user in the window itself; keep waiting.
      await page.goto(startUrl).catch((err: unknown) => log.warn("Login window could not load the start page", {
        message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      }));

      const deadline = Date.now() + timeoutMs;
      const pollMs = this.options.pollMs ?? 1000;
      while (!closed) {
        for (const p of context.pages()) {
          if (!p.url().startsWith(origin)) continue;
          const entries = await p.evaluate(() => Object.entries(window.localStorage)).catch(() => []);
          const login = findLogin(entries);
          if (login) return { status: "logged_in", login };
        }
        // Closing the last tab closes the window: treat it as the user cancelling.
        if (context.pages().length === 0) return { status: "cancelled" };
        if (Date.now() > deadline) return { status: "timed_out" };
        await new Promise((r) => setTimeout(r, pollMs));
      }
      return { status: "cancelled" };
    } finally {
      if (!closed) await context.close().catch(() => {});
    }
  }

  private async launch() {
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new SKaupatError("login_window_unavailable", "playwright-core is not installed.");
    }
    const executablePath = this.options.executablePath ?? process.env.SKAUPAT_BROWSER_PATH;
    const candidates: { channel?: string; executablePath?: string }[] = executablePath
      ? [{ executablePath }]
      : [{ channel: "msedge" }, { channel: "chrome" }];
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        return await chromium.launchPersistentContext(this.options.profileDir, {
          ...candidate,
          headless: this.options.headless ?? false,
          viewport: null,
          // Playwright's default flags tune the browser for test automation (and show a "controlled by
          // automated test software" bar). The login window should be a plain browser, so only the
          // flags it needs are passed.
          ignoreDefaultArgs: true,
          args: browserArgs(this.options.profileDir, this.options.headless ?? false),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        if (/already in use|ProcessSingleton|SingletonLock/i.test(message)) {
          throw new SKaupatError("login_window_unavailable", "The login window is already open in another process.");
        }
        errors.push(`${candidate.channel ?? candidate.executablePath}: ${message}`);
      }
    }
    throw new SKaupatError(
      "login_window_unavailable",
      `No usable browser for the login window (needs Microsoft Edge or Google Chrome, or SKAUPAT_BROWSER_PATH). ${errors.join("; ")}`,
    );
  }
}

function browserArgs(profileDir: string, headless: boolean): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    "--window-size=520,820",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    // Edge otherwise signs a new profile in with the Windows Microsoft account. This profile should
    // only ever hold the S-kaupat login.
    "--disable-features=msImplicitSignin",
    ...(headless ? ["--headless", "--no-sandbox"] : []),
    "about:blank",
  ];
}

/** Looks through localStorage entries for an object holding a non-empty refreshToken. */
export function findLogin(entries: [string, string][]): CapturedLogin | null {
  for (const [, value] of entries) {
    const found = search(parseJson(value), 0);
    if (found) return found;
  }
  return null;
}

function search(node: unknown, depth: number): CapturedLogin | null {
  if (depth > 8 || node === null || typeof node !== "object") {
    // Some stores keep JSON encoded inside a string value.
    if (typeof node === "string" && depth <= 8 && /^[[{]/.test(node)) return search(parseJson(node), depth + 1);
    return null;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.refreshToken === "string" && record.refreshToken) {
    return {
      refreshToken: record.refreshToken,
      accessToken: typeof record.accessToken === "string" && record.accessToken ? record.accessToken : null,
    };
  }
  for (const child of Object.values(record)) {
    const found = search(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
