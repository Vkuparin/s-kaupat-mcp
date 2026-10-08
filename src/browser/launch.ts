import type { BrowserContext } from "playwright-core";
import { type ErrorCode, SKaupatError } from "../errors.js";

export interface LaunchOptions {
  /** The server's own browser profile folder (never the user's everyday profile). */
  profileDir: string;
  headless: boolean;
  /** Start the window minimised (in the taskbar), for the API session. */
  minimized?: boolean;
  /** A Chromium-based browser to use instead of the installed Edge or Chrome. */
  executablePath?: string;
  /** Error code for "no usable browser" and "profile already open elsewhere". */
  unavailableCode: ErrorCode;
  busyCode: ErrorCode;
}

/**
 * Opens the server's browser profile in the installed Microsoft Edge (always
 * there on Windows) or Google Chrome. Shared by the login window (visible) and
 * the API session (headless), which use the same profile so they share the
 * S-kaupat session. Only one process can have a profile open at a time.
 */
export async function launchProfile(options: LaunchOptions): Promise<BrowserContext> {
  let chromium: typeof import("playwright-core").chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch (err) {
    throw new SKaupatError(
      options.unavailableCode,
      `Could not load playwright-core: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    );
  }
  const executablePath = options.executablePath;
  const candidates: { channel?: string; executablePath?: string }[] = executablePath
    ? [{ executablePath }]
    : [{ channel: "msedge" }, { channel: "chrome" }];
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return await chromium.launchPersistentContext(options.profileDir, {
        ...candidate,
        headless: options.headless,
        viewport: null,
        // Playwright's default flags tune the browser for test runs; only the flags this window
        // needs are passed. --enable-automation stays (see browserArgs): the window does not hide
        // that it is driven by software.
        ignoreDefaultArgs: true,
        args: browserArgs(options),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
      if (/already in use|ProcessSingleton|SingletonLock/i.test(message)) {
        throw new SKaupatError(options.busyCode, "The S-kaupat browser profile is open in another process.");
      }
      errors.push(`${candidate.channel ?? candidate.executablePath}: ${message}`);
    }
  }
  throw new SKaupatError(
    options.unavailableCode,
    `No usable browser (needs Microsoft Edge or Google Chrome, or the browserPath setting). ${errors.join("; ")}`,
  );
}

export function browserArgs({ profileDir, headless, minimized }: LaunchOptions): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-pipe",
    // Kept on purpose: the browser shows it is software-driven (navigator.webdriver, the infobar).
    "--enable-automation",
    "--window-size=520,820",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    // Edge otherwise signs a new profile in with the Windows Microsoft account. This profile should
    // only ever hold the S-kaupat login.
    "--disable-features=msImplicitSignin",
    ...(headless ? ["--headless", "--no-sandbox"] : []),
    ...(minimized && !headless ? ["--start-minimized"] : []),
    "about:blank",
  ];
}
