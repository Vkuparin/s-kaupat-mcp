import { SKaupatError } from "../errors.js";
import { log } from "../log.js";
import type { ApiPage } from "./session.js";

export interface BrowserFetchOptions {
  /** Where the S-kaupat tab comes from (BrowserSession.apiPage). */
  page: () => Promise<ApiPage>;
  /** At least this long between API calls, so a model looping over a list never bursts. Default 500 ms. */
  minIntervalMs?: number;
  timeoutMs?: number;
}

interface InPageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

type InPageResult =
  | { ok: true; status: number; contentType: string | null; body: string }
  | { ok: false; error: string };

/** Headers the page's own fetch sets (and won't let a script set). */
const BROWSER_OWNED_HEADERS = new Set(["origin", "referer", "user-agent", "cookie", "host", "content-length"]);

/**
 * A fetch() replacement that sends each request from inside the S-kaupat
 * page, so S-kaupat sees the same requests its website makes. Plugs into the
 * fetchImpl option of HttpSKaupatClient and HttpAuthApi; nothing else in the
 * client changes.
 *
 * Calls go one at a time with a minimum gap. When S-kaupat refuses a call
 * (403/429 or a blocked request), the page is reloaded once and the call
 * retried once, as the site may need to settle its own check.
 */
export function createBrowserFetch(options: BrowserFetchOptions): typeof fetch {
  const minIntervalMs = options.minIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let queue: Promise<unknown> = Promise.resolve();
  let lastCall = 0;

  const send = async (request: InPageRequest): Promise<InPageResult> => {
    const wait = lastCall + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const page = await options.page();
    return page.evaluate(inPageFetch, request);
  };

  const run = async (request: InPageRequest): Promise<Response> => {
    let result = await send(request);
    if (refused(result)) {
      log.warn("S-kaupat refused a request from the page; reloading once", { detail: describe(result) });
      await (await options.page()).reload().catch(() => {});
      result = await send(request);
    }
    if (!result.ok) {
      if (/timed out/i.test(result.error)) throw new SKaupatError("unavailable", "S-kaupat did not respond in time.");
      throw new SKaupatError("blocked", `The request from the S-kaupat page failed: ${result.error}`);
    }
    return new Response(result.body, {
      status: result.status,
      headers: result.contentType ? { "content-type": result.contentType } : {},
    });
  };

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const request: InPageRequest = {
      url: String(input instanceof Request ? input.url : input),
      method: init.method ?? "GET",
      headers: pageHeaders(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      timeoutMs,
    };
    const next = queue.then(() => run(request));
    // Keep the queue going whether this call succeeds or fails.
    queue = next.catch(() => {});
    return next;
  }) as typeof fetch;
}

function pageHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new Headers(headers).entries()) {
    if (!BROWSER_OWNED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

function refused(result: InPageResult): boolean {
  return result.ok ? result.status === 403 || result.status === 429 : !/timed out/i.test(result.error);
}

function describe(result: InPageResult): string {
  return result.ok ? `HTTP ${result.status}` : result.error;
}

/** Runs inside the page. Must be self-contained: it is serialised and sent to the browser. */
async function inPageFetch(req: InPageRequest): Promise<InPageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      signal: controller.signal,
    });
    return { ok: true, status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: aborted ? "timed out" : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
