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

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const context = this.context;
    this.context = null;
    this.page = null;
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
      // Edge may open its own start tab or restore old ones; one S-kaupat tab is all the window needs.
      for (const other of context.pages()) if (other !== page) await other.close().catch(() => {});
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
