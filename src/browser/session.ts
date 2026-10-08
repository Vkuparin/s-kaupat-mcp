import type { BrowserContext, Page } from "playwright-core";
import { SKaupatError } from "../errors.js";
import { log } from "../log.js";
import { launchProfile } from "./launch.js";

/** What browserFetch needs from a page; a seam so tests can use a fake page. */
export interface ApiPage {
  evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
  reload(): Promise<unknown>;
}

export interface BrowserSessionOptions {
  /** The same profile the login window uses, so both share one S-kaupat session. */
  profileDir: string;
  startUrl?: string;
  executablePath?: string;
  /** Close the browser after this long without API calls. Default 3 minutes. */
  idleMs?: number;
  /** Wait before the one retry when the profile is busy. Default 2 s. */
  busyRetryMs?: number;
  /** Opens the browser; replaced in tests. */
  launch?: () => Promise<BrowserContext>;
}

/**
 * One Edge/Chrome window owned by the server, started minimised, with one tab
 * parked on www.s-kaupat.fi. API calls run as fetch() inside that tab (see
 * browser-fetch.ts), as k-ruoka-mcp does for K-Ruoka: S-kaupat's API answers
 * its own website's page, while plain scripts get 403. The browser is a normal
 * browser window and does not disguise itself.
 *
 * The browser starts on the first API call, closes after an idle period, and
 * always closes gracefully so the profile's storage is saved. While the login
 * window has the profile open, API calls fail fast with login_in_progress
 * instead of waiting for the user.
 */
export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  private suspended: Promise<unknown> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly startUrl: string;
  /** The window opened for the user with openForUser, kept open until they close it. */
  private userPage: Page | null = null;
  private expectUserPage: ((page: Page) => void) | null = null;

  constructor(private readonly options: BrowserSessionOptions) {
    this.startUrl = options.startUrl ?? "https://www.s-kaupat.fi/";
  }

  /** The S-kaupat tab, launching the browser if needed. */
  async apiPage(): Promise<ApiPage> {
    if (this.suspended) {
      throw new SKaupatError("login_in_progress", "The S-kaupat login window is open.");
    }
    this.touch();
    if (this.page && !this.page.isClosed()) return this.page;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Closes the API browser, runs `fn` (the login window, which needs the same
   * profile) and lets the next API call start it again.
   */
  async whileClosed<T>(fn: () => Promise<T>): Promise<T> {
    const run = (async () => {
      await this.starting?.catch(() => {});
      await this.close();
      return fn();
    })();
    this.suspended = run;
    try {
      return await run;
    } finally {
      this.suspended = null;
    }
  }

  /**
   * Opens `url` in a normal, visible window of the server's own browser, which is already logged in,
   * so the user can finish on the site there. One such window at a time: a second call reuses it.
   * The API tab stays in its own minimised window, and the browser stays open while this window is.
   */
  async openForUser(url: string): Promise<void> {
    if (this.suspended) throw new SKaupatError("login_in_progress", "The S-kaupat login window is open.");
    await this.apiPage();
    const existing = this.userPage;
    if (existing && !existing.isClosed()) {
      await existing.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await showWindow(this.context!, existing);
      return;
    }
    const context = this.context!;
    const opened = new Promise<Page>((resolve) => {
      this.expectUserPage = resolve;
    });
    try {
      const cdp = await context.newCDPSession(this.page!);
      await cdp.send("Target.createTarget", { url, newWindow: true });
      await cdp.detach().catch(() => {});
      const page = await withTimeout(opened, 10_000);
      this.userPage = page;
      page.on("close", () => {
        if (this.userPage === page) this.userPage = null;
        this.touch();
      });
      await showWindow(context, page);
      log.info("Opened S-kaupat for the user");
    } catch (err) {
      log.warn("Could not open S-kaupat for the user", { message: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      throw new SKaupatError("unavailable", "Could not open the S-kaupat window.");
    } finally {
      this.expectUserPage = null;
    }
  }

  /** The site's own localStorage in the server's profile. Holds the login too: never log it. */
  async siteStorage(): Promise<{ entries: [string, string][]; userPagePath: string | null }> {
    const page = (await this.apiPage()) as Page;
    const entries = await page.evaluate(() => Object.entries(window.localStorage));
    const userUrl = this.userPage && !this.userPage.isClosed() ? this.userPage.url() : null;
    return { entries, userPagePath: userUrl ? new URL(userUrl).pathname : null };
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const context = this.context;
    this.context = null;
    this.page = null;
    this.userPage = null;
    if (context) await context.close().catch(() => {});
  }

  private async start(): Promise<Page> {
    const launch =
      this.options.launch ??
      (() =>
        launchProfile({
          profileDir: this.options.profileDir,
          headless: false,
          minimized: true,
          executablePath: this.options.executablePath,
          unavailableCode: "browser_unavailable",
          busyCode: "browser_busy",
        }));
    const context = await launch().catch(async (err) => {
      // A window that was just closed can hold the profile for a moment; try once more.
      if (!(err instanceof SKaupatError && err.code === "browser_busy")) throw err;
      await new Promise((r) => setTimeout(r, this.options.busyRetryMs ?? 2_000));
      return launch();
    });
    this.context = context;
    context.on("close", () => {
      if (this.context === context) {
        this.context = null;
        this.page = null;
      }
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      // Edge does not always honour --start-minimized (for example when it restores the profile's last
      // window), so the window is also minimised through the browser's own window controls.
      await minimize(context, page);
      await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });
      // Edge may open its own start tab or restore old ones, sometimes only after the window is up
      // (seen live 2026-10-08: a leftover about:blank tab); one S-kaupat tab is all the window needs.
      for (const other of context.pages()) if (other !== page) await other.close().catch(() => {});
      context.on("page", (other) => {
        if (other === page) return;
        if (this.expectUserPage) return this.expectUserPage(other);
        void other.close().catch(() => {});
      });
      this.page = page;
      log.info("S-kaupat browser session started");
      return page;
    } catch (err) {
      await this.close();
      log.warn("Could not open S-kaupat in the browser", {
        message: err instanceof Error ? err.message.split("\n")[0] : String(err),
      });
      throw new SKaupatError("unavailable", "Could not open S-kaupat in the browser.");
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // The user is still using the window opened for them; closing it would lose their place.
      if (this.userPage && !this.userPage.isClosed()) return this.touch();
      log.debug("Closing idle S-kaupat browser session");
      void this.close();
    }, this.options.idleMs ?? 3 * 60_000);
    this.idleTimer.unref();
  }
}

/** Minimises the page's window via the DevTools protocol. Best effort: a visible window still works. */
async function minimize(context: BrowserContext, page: Page): Promise<void> {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    await cdp.detach().catch(() => {});
  } catch (err) {
    log.debug("Could not minimise the S-kaupat window", { message: err instanceof Error ? err.message : String(err) });
  }
}

/** Brings the user's window up from wherever it opened. Best effort. */
async function showWindow(context: BrowserContext, page: Page): Promise<void> {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await cdp.detach().catch(() => {});
  } catch (err) {
    log.debug("Could not restore the S-kaupat window", { message: err instanceof Error ? err.message : String(err) });
  }
  await page.bringToFront().catch(() => {});
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}
