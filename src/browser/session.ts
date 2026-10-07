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
  /** Close the browser after this long without API calls. Default 10 minutes. */
  idleMs?: number;
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
    const context = await (this.options.launch ??
      (() =>
        launchProfile({
          profileDir: this.options.profileDir,
          headless: false,
          minimized: true,
          executablePath: this.options.executablePath,
          unavailableCode: "browser_unavailable",
          busyCode: "browser_busy",
        })))();
    this.context = context;
    context.on("close", () => {
      if (this.context === context) {
        this.context = null;
        this.page = null;
      }
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(this.startUrl, { waitUntil: "domcontentloaded" });
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
    }, this.options.idleMs ?? 10 * 60_000);
    this.idleTimer.unref();
  }
}
