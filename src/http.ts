import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { log } from "./log.js";
import type { SKaupatRuntime } from "./runtime.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** Every request must send it as `Authorization: Bearer <key>`. */
  accessKey: string;
}

export interface RunningHttpServer {
  /** The MCP endpoint, e.g. http://127.0.0.1:8717/mcp */
  url: string;
  close(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Serves MCP over Streamable HTTP at /mcp, for apps that can't use stdio.
 * Stateless: each request gets a fresh MCP server on the shared runtime, so the
 * login, browser window and store choice carry over between requests.
 *
 * Guards: a required access key (separate from the S-kaupat login, which never
 * leaves the server), and, when listening on localhost, requests must also be
 * addressed to localhost and must not come from a web page on another site
 * (DNS rebinding).
 */
export async function startHttpServer(runtime: SKaupatRuntime, options: HttpOptions): Promise<RunningHttpServer> {
  const expected = Buffer.from(`Bearer ${options.accessKey}`);
  const loopbackOnly = LOOPBACK.has(options.host);

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log.error("HTTP request failed", { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) send(res, 500, "Internal error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/mcp") return send(res, 404, "Not found. The MCP endpoint is /mcp.");
    if (loopbackOnly && !isLoopbackHost(req.headers.host)) return send(res, 403, "Forbidden host.");
    const origin = req.headers.origin;
    if (origin && origin !== "null" && !isLoopbackOrigin(origin)) return send(res, 403, "Forbidden origin.");
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      return send(res, 401, "Missing or wrong access key.");
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, 405, "Only POST is supported (stateless server).");
    }

    const mcp = runtime.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function send(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0]!;
  return LOOPBACK.has(host);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}
