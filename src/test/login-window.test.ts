import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BrowserLoginWindow } from "../auth/login-window.js";

/**
 * Drives the real login window headless against a local stand-in for the
 * site. Needs a Chromium build: set SKAUPAT_TEST_BROWSER, or have Playwright's
 * bundled one at the default cloud path. Skipped otherwise.
 */
const browser = process.env.SKAUPAT_TEST_BROWSER ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = existsSync(browser) ? false : `no Chromium at ${browser}`;

async function fakeSite(html: string) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

async function window(startUrl: string) {
  return new BrowserLoginWindow({
    profileDir: await mkdtemp(join(tmpdir(), "skaupat-profile-")),
    startUrl,
    executablePath: browser,
    headless: true,
    pollMs: 50,
  });
}

test("captures the login once the site stores tokens", { skip }, async () => {
  // The "user" logs in a moment after the page loads.
  const site = await fakeSite(`<script>
    localStorage.setItem("customer-storage", "{}");
    setTimeout(() => localStorage.setItem("session-storage",
      JSON.stringify({ state: { accessToken: "acc", refreshToken: "ref" } })), 300);
  </script>`);
  try {
    const result = await (await window(site.url)).open(15_000);
    assert.deepEqual(result, { status: "logged_in", login: { refreshToken: "ref", accessToken: "acc" } });
  } finally {
    site.close();
  }
});

test("times out when the user never logs in", { skip }, async () => {
  const site = await fakeSite("<p>Kirjaudu</p>");
  try {
    assert.deepEqual(await (await window(site.url)).open(500), { status: "timed_out" });
  } finally {
    site.close();
  }
});

test("closing the window counts as cancelled", { skip: skip || (process.platform === "win32" && "uses pkill") }, async () => {
  const site = await fakeSite("<p>Kirjaudu</p>");
  const profileDir = await mkdtemp(join(tmpdir(), "skaupat-profile-"));
  const w = new BrowserLoginWindow({ profileDir, startUrl: site.url, executablePath: browser, headless: true, pollMs: 50 });
  try {
    const result = w.open(10_000);
    // The user closing the window ends the browser process.
    setTimeout(() => execFile("pkill", ["-f", profileDir]), 1500);
    assert.deepEqual(await result, { status: "cancelled" });
  } finally {
    site.close();
  }
});
