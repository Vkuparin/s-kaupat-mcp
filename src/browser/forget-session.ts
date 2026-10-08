import { SKaupatError } from "../errors.js";
import { log } from "../log.js";
import { launchProfile } from "./launch.js";

/**
 * Clears the S-kaupat session in the server's own browser profile: the site's storage (which holds
 * its tokens) and the profile's cookies (the sign-in service's too), so the next login window asks
 * for the account. Opens the profile minimised for a moment; the profile must not be open elsewhere.
 */
export async function forgetSiteSession(options: { profileDir: string; executablePath?: string; siteUrl?: string }): Promise<void> {
  const context = await launchProfile({
    profileDir: options.profileDir,
    headless: false,
    minimized: true,
    executablePath: options.executablePath,
    unavailableCode: "browser_unavailable",
    busyCode: "browser_busy",
  });
  try {
    await context.clearCookies();
    const page = context.pages()[0] ?? (await context.newPage());
    // Storage is per site: it can only be cleared from a page of that site.
    // If the site can't be opened (offline), its storage can't be cleared either: say so rather than
    // let the next login pick the old account up from it.
    try {
      await page.goto(options.siteUrl ?? "https://www.s-kaupat.fi/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });
    } catch (err) {
      log.warn("Could not clear the site's storage", { message: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      throw new SKaupatError("unavailable", "Could not open S-kaupat to finish logging out.");
    }
    await context.clearCookies();
  } finally {
    await context.close().catch(() => {});
  }
}
