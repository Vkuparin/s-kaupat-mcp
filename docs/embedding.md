# Shipping s-kaupat-mcp inside your app

The server is a plain [MCP](https://modelcontextprotocol.io) server. It does not depend on Claude or any other app: your app starts it, talks MCP to it, and stops it. This page covers how to package it, how to configure it, and what it needs on the user's PC. For what to show the user, see [caller-guide.md](caller-guide.md).

## Pick a package

| Package | What it is | Use it when |
|---|---|---|
| `s-kaupat-mcp.exe` | The server with Node.js inside, one file (about 110 MB) | Your app is not a Node app, or you don't want to ship Node |
| `s-kaupat-mcp.cjs` | The server as one JavaScript file (about 5 MB) | Your app ships Node.js 20 or newer: run `node s-kaupat-mcp.cjs` |
| npm package (`s-kaupat-mcp-<version>.tgz`) | Command line plus a library API | Your app is a Node app and wants the server in its own process |
| `s-kaupat-<version>.mcpb` | Claude Desktop extension | Installing for Claude Desktop |

Each release also has `tools.json` (every tool's name, description and input schema, with `version` and `schemaVersion`, so an app can check what it builds against without starting the server; `npm run export:tools` writes it locally) and `SHA256SUMS`, to check the files an app downloads and ships.

All four are built by the **Release** GitHub Actions workflow (run it by hand for a build artifact, or push a `v*` tag for a GitHub release). To build locally: `npm run build:standalone` (exe and `.cjs` for the platform you build on), `npm pack` and `npm run pack:extension`.

## Run it over stdio

Start the executable as a child process and speak MCP over its stdin and stdout. Logs go to stderr. Close stdin (or send SIGTERM) to stop it; it closes its browser window first so the login is saved.

```text
s-kaupat-mcp.exe --data-dir "%LOCALAPPDATA%\MyApp\s-kaupat"
```

Any MCP client library works. With the official TypeScript SDK:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "C:\\Program Files\\MyApp\\s-kaupat-mcp.exe",
  args: ["--data-dir", dataDir],
});
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);
const status = await client.callTool({ name: "get_setup_status", arguments: {} });
```

## Or over local HTTP

For apps that can't use stdio, the server can serve MCP over [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http) on the user's own PC:

```text
set SKAUPAT_ACCESS_KEY=<at least 24 random characters your app generates and keeps>
s-kaupat-mcp.exe --http-port 8717 --data-dir "%LOCALAPPDATA%\MyApp\s-kaupat"
```

- The endpoint is `http://127.0.0.1:8717/mcp`. Every request needs `Authorization: Bearer <access key>`. The key is separate from the S-kaupat login, which never leaves the server. It is read only from the environment or the config file, never from a flag, so it doesn't show up in process lists.
- It listens on `127.0.0.1` only. Requests must be addressed to localhost, and requests a web page sends from another site are refused, so a website the user visits can't reach it.
- It is stateless: send `POST` requests; no session is kept between them. The login, the browser window and the store choice still carry over, because they belong to the running server.
- `--http-port 0` picks a free port; the server logs the URL on stderr.

A Node app can do the same in-process with `startHttpServer(runtime, { host, port, accessKey })`.

## Or run it inside your Node app

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, loadConfig } from "s-kaupat-mcp";

const { config } = loadConfig({ argv: ["--data-dir", dataDir] });
const runtime = createRuntime(config);

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await runtime.createMcpServer().connect(serverSide);
const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(clientSide);

// On shutdown:
await runtime.close();
```

One runtime holds the login, the browser window, the store choice and orders waiting for the user's Order press. `createMcpServer()` can be called again for more connections; they all share that state, so an order reviewed on one connection can be placed on another. The library also exports `USER_MESSAGES`, `ERROR_ACTIONS` and the error and config types.

## Settings

Each setting comes from, highest first: a command-line flag, an environment variable, a JSON config file (`--config <file>` or `SKAUPAT_CONFIG`), or the default. An unknown setting or a bad value stops the server with exit code 2 and a message on stderr, rather than being ignored.

| Config file key | Environment variable | Flag | Default | Meaning |
|---|---|---|---|---|
| `mode` | `SKAUPAT_MODE` | `--demo` | `live` | `live` or `demo` (built-in sample stores and products, no network, login always succeeds). `SKAUPAT_DEMO=true` also means demo |
| `transport` | `SKAUPAT_TRANSPORT` | `--transport` | `browser` | `browser` sends S-kaupat calls from the server's own browser window; `direct` uses plain HTTP, which S-kaupat currently refuses |
| `dataDir` | `SKAUPAT_DATA_DIR` | `--data-dir` | `%LOCALAPPDATA%\s-kaupat-mcp` | Browser profile, lock files and the login file. Give your app its own folder |
| `settingsFile` | `SKAUPAT_SETTINGS_FILE` | | `<dataDir>\settings.json` when `dataDir` is set, else `%APPDATA%\s-kaupat-mcp\settings.json`; `demo-settings.json` next to it in demo mode | The user's chosen store and time |
| `tokenStore` | `SKAUPAT_TOKEN_STORE` | | `credential-manager` on Windows, `file` elsewhere | Where the login (refresh token) is kept |
| `tokenFile` | `SKAUPAT_TOKEN_FILE` | | `<dataDir>\refresh-token` | Login file when `tokenStore` is `file` |
| `browserPath` | `SKAUPAT_BROWSER_PATH` | | Edge, then Chrome | A Chromium-based browser to use instead |
| `loginUrl` | `SKAUPAT_LOGIN_URL` | | `https://www.s-kaupat.fi/` | Page the login window opens |
| `demoCatalogueFile` | `SKAUPAT_FIXTURES` | | built in | A JSON catalogue for demo mode |
| `debug` | `SKAUPAT_DEBUG` (`1`) | `--debug` | off | Log each API request to stderr (never tokens) |
| `httpPort` | `SKAUPAT_HTTP_PORT` | `--http-port` | none (stdio) | Serve MCP over HTTP on this port instead of stdio |
| `httpHost` | `SKAUPAT_HTTP_HOST` | `--http-host` | `127.0.0.1` | Address to listen on |
| `accessKey` | `SKAUPAT_ACCESS_KEY` | | none | Required with `httpPort`, at least 24 characters |
| `ordering` | `SKAUPAT_ORDERING` (`false`) | | `true` | `false` turns `place_order` off, for apps that only want lists and prices |

Example `config.json`:

```json
{
  "dataDir": "C:\\Users\\Ville\\AppData\\Local\\MyApp\\s-kaupat",
  "tokenStore": "credential-manager"
}
```

With `tokenStore: "credential-manager"` the login is saved in Windows Credential Manager under one shared name, so every app on the PC that uses this server shares the user's S-kaupat login. Use `tokenStore: "file"` with your own `dataDir` to keep a login per app.

## What the user's PC needs

- **Windows 10 or 11 with Microsoft Edge** (always installed) or Google Chrome. S-kaupat only answers requests from its own website, so the server sends them from its own browser window. That window opens minimised in the taskbar on the first call and closes after 3 idle minutes. It uses its own browser profile in `dataDir`, never the user's everyday browser.
- **A desktop session.** Logging in opens a small S-kaupat window on the user's screen, and the API window is a real window too. Run the server as the signed-in user, started by your app (for example when your app starts, or from its tray icon). It cannot run as a Windows service or under another account, because those have no desktop the user can see.
- **One server per data folder.** Only one process can use a browser profile at a time. A second copy with the same `dataDir` answers `browser_busy` while the first one's window is open. Run one server per app and give it its own `dataDir`.
- Network access to `www.s-kaupat.fi` and `api.s-kaupat.fi`.

Nothing is installed and no admin rights are needed. The exe is not code-signed yet, so Windows SmartScreen may warn the first time an unsigned app starts it from a downloaded file; ship it inside your own signed installer.

## Versions

`--version` prints the server version. Every tool result carries `schemaVersion`, which changes when a result shape changes incompatibly, so your app can check it once at start.
