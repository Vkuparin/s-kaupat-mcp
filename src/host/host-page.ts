import { SKaupatError } from "../errors.js";
import type { ApiPage } from "../browser/session.js";

/**
 * The host app's own S-kaupat page, reached over a small local protocol (docs/host-page.md).
 *
 * With the host transport the server runs no browser of its own. The app that started it keeps an
 * S-kaupat page signed in (for example a view in its own window) and answers a few fixed requests
 * on a local address: send one request from the page, read the page's localStorage, reload the
 * page, show a page to the user and forget the session. Nothing else can be asked of it, so the
 * server never runs script in the page.
 */
export interface HostPageOptions {
  /** Base address of the host's endpoint, for example http://127.0.0.1:8730/s-kaupat. */
  url: string;
  /** Sent as "Authorization: Bearer <key>" on every request. */
  key: string;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
  /** How long to wait for the host to answer one request. Default 30 s. */
  timeoutMs?: number;
}

/** What the page's fetch returned, or why it could not send (the shape browser-fetch expects). */
export type HostFetchResult =
  | { ok: true; status: number; contentType: string | null; body: string }
  | { ok: false; error: string };

export interface HostFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

interface HostReply {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

export class HostPage {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HostPageOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /**
   * The page as the shared fetch queue (createBrowserFetch) expects it. The host answers only the
   * page's own fetch, so evaluate ignores the function it is given and sends the request.
   */
  apiPage(): ApiPage {
    return {
      evaluate: (async (_inPageFetch: unknown, request: HostFetchRequest) => {
        const reply = await this.call("fetch", request, request.timeoutMs + 5_000);
        return reply as unknown as HostFetchResult;
      }) as ApiPage["evaluate"],
      reload: async () => {
        await this.call("reload", {});
      },
    };
  }

  /** The site's localStorage in the host's page, and the path the page is on. */
  async storage(): Promise<{ entries: [string, string][]; userPagePath: string | null }> {
    const reply = await this.call("storage", {});
    const entries = Array.isArray(reply.entries)
      ? reply.entries.filter((e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string")
      : [];
    return { entries, userPagePath: typeof reply.path === "string" ? reply.path : null };
  }

  /** Shows this S-kaupat page to the user in the host app. */
  async open(url: string): Promise<void> {
    await this.call("open", { url });
  }

  /** Clears the site's storage and sign-in cookies in the host's session, so the next sign-in asks for the account. */
  async forget(): Promise<void> {
    await this.call("forget", {});
  }

  private async call(op: string, body: unknown, timeoutMs = this.timeoutMs): Promise<HostReply> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SKaupatError("unavailable", "The app's S-kaupat page did not answer.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new SKaupatError("unavailable", "The app's S-kaupat page refused the server's key.");
    }
    const reply = (await response.json().catch(() => null)) as HostReply | null;
    if (!response.ok || !reply || typeof reply !== "object") {
      throw new SKaupatError("unavailable", `The app's S-kaupat page answered HTTP ${response.status}.`);
    }
    // A failed fetch carries its own ok:false (the page could not send); other ops report errors here.
    if (op !== "fetch" && reply.ok === false) {
      throw new SKaupatError("unavailable", `The app's S-kaupat page could not do "${op}"${reply.error ? `: ${String(reply.error).slice(0, 80)}` : ""}.`);
    }
    return reply;
  }
}
