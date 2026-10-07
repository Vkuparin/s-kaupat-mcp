# s-kaupat-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) browse the [S-kaupat.fi](https://www.s-kaupat.fi) grocery catalogue: find stores, search products and refresh exact products by ID.

Status: **early scaffold (v0.2.0)**. Catalogue tools and login; no shopping list or cart tools yet. Live access to S-kaupat is unverified, see [Live mode](#live-mode). The roadmap is in [docs/s-kaupat-mcp-plan.md](docs/s-kaupat-mcp-plan.md) and what is known about the S-kaupat API is in [docs/s-kaupat-api.md](docs/s-kaupat-api.md).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_stores` | `query` (name, city or postal code), `limit` | Stores with IDs, chain, address |
| `search_products` | `storeId`, `query`, `limit` | Products in that store: ID (EAN), name, brand, price, campaign price, comparison price and unit, price basis, observation time |
| `get_products` | `storeId`, `ids[]` | One result per ID: `found` with the product, `not_found`, or `unknown` |
| `login_status` | none | `logged_in` (with the account holder's first name), `logged_out` or `expired`. Never opens a window |
| `start_login` | `timeoutSeconds` (30 to 900, default 300) | Opens the server's own small login window and waits: `logged_in`, `cancelled` or `timed_out`, each with a Finnish and English message |

Prices are per store, so product tools always take a `storeId` from `search_stores`. Fields S-kaupat does not report come back as `null` (or `"unknown"`) rather than guessed.

Every result carries `schemaVersion`. Failures come back as MCP tool errors (`isError: true`) with a stable code, a technical `message` for logs, and a short `userMessage` in Finnish and English that an app can show as-is:

```json
{
  "schemaVersion": "0.2",
  "error": {
    "code": "login_required",
    "message": "No stored S-kaupat login.",
    "userMessage": { "fi": "Kirjaudu ensin S-kaupat-tilillesi.", "en": "Please log in to your S-kaupat account first." }
  }
}
```

Apps should branch on `code`, never on the message text. The codes an app is most likely to act on:

| Code | What the app should do |
|---|---|
| `login_required` | Show a "Log in" button that calls `start_login` |
| `session_expired` | Same: the saved login stopped working, so the user logs in again |
| `login_window_unavailable` | The login window can't open on this device (no Edge or Chrome) |
| `store_not_selected` | Ask the user to choose a store |
| `store_not_found` | The store ID is wrong or the store closed; pick another |
| `product_unavailable` | The product isn't sold or orderable in this store |
| `unavailable`, `blocked` | S-kaupat is slow or refused; retry a little later |

The full list, with every message, is in [src/errors.ts](src/errors.ts). Invalid arguments are rejected by schema validation before a tool runs.

## Login

Catalogue tools work without logging in. Account features (shopping lists, coming next) need a login:

1. The app calls `login_status` to show whether the user is logged in, and by which name.
2. When the user presses the app's "Log in" button, the app calls `start_login`. A small S-kaupat window opens; the user logs in as usual, and the window closes by itself. The tool returns once they finish, close the window or the time runs out. It is never opened implicitly by other tools.
3. The server keeps only the S-kaupat **refresh token**: in Windows Credential Manager on Windows, or in a file readable only by the user elsewhere. Access tokens stay in memory and are renewed quietly before they expire. Several apps running the server at once share the login safely: renewal takes a lock and re-reads the saved token first. Tokens are never logged.

The login window uses its own browser profile under the data folder, not your everyday browser, and needs Microsoft Edge or Google Chrome installed (or `SKAUPAT_BROWSER_PATH`). In `SKAUPAT_MODE=fixtures`, `start_login` succeeds at once as user "Testi", so apps can build their login UI offline.

Not yet checked against the live site: which localStorage entry the site keeps its tokens in (the window looks for any stored object with a `refreshToken`), whether `authTokens(refreshToken)` renews outside the browser, and whether S-kaupat rotates refresh tokens.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
npm run build
npm test
```

Try it interactively with the MCP Inspector:

```bash
npm run inspect
```

## Claude Desktop

Open Claude Desktop → Settings → Developer → Edit Config, and add the server to `claude_desktop_config.json`. Use the absolute path to `dist/index.js` in your checkout.

Offline sample data (works right away, no network):

```json
{
  "mcpServers": {
    "s-kaupat": {
      "command": "node",
      "args": ["D:\\AIstuff\\repos\\s-kaupat-mcp\\dist\\index.js"],
      "env": { "SKAUPAT_MODE": "fixtures" }
    }
  }
}
```

Live S-kaupat (needs the hashes described below):

```json
{
  "mcpServers": {
    "s-kaupat": {
      "command": "node",
      "args": ["D:\\AIstuff\\repos\\s-kaupat-mcp\\dist\\index.js"],
      "env": {
        "SKAUPAT_PRODUCT_SEARCH_HASH": "<sha256 for RemoteFilteredProducts>",
        "SKAUPAT_STORE_SEARCH_HASH": "<sha256 for RemoteStoreSearch>"
      }
    }
  }
}
```

On macOS or Linux use a normal path such as `/Users/you/s-kaupat-mcp/dist/index.js`. Restart Claude Desktop after editing the config. Server logs go to stderr and show up in Claude Desktop's MCP logs.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SKAUPAT_MODE` | `live` | `live` calls S-kaupat; `fixtures` serves `fixtures/catalogue.json` with no network |
| `SKAUPAT_FIXTURES` | `fixtures/catalogue.json` | Alternative fixture catalogue |
| `SKAUPAT_PRODUCT_SEARCH_HASH` | none | Persisted query hash for `RemoteFilteredProducts` |
| `SKAUPAT_STORE_SEARCH_HASH` | none | Persisted query hash for `RemoteStoreSearch` |
| `SKAUPAT_DATA_DIR` | `%LOCALAPPDATA%\s-kaupat-mcp` on Windows, `~/.config/s-kaupat-mcp` elsewhere | Lock file, token file and the login window's browser profile |
| `SKAUPAT_TOKEN_STORE` | `credential-manager` on Windows, `file` elsewhere | Where the refresh token is kept |
| `SKAUPAT_TOKEN_FILE` | `<data dir>/refresh-token` | Token file path when `SKAUPAT_TOKEN_STORE=file` |
| `SKAUPAT_BROWSER_PATH` | Edge, then Chrome | A Chromium-based browser for the login window |
| `SKAUPAT_LOGIN_URL` | `https://www.s-kaupat.fi/` | Page the login window opens |
| `SKAUPAT_DEBUG` | off | `1` logs each API request to stderr (never tokens) |

## Live mode

S-kaupat's site uses a GraphQL API at `api.s-kaupat.fi` that only accepts *persisted query hashes*, and those hashes change when S-kaupat deploys. Until automatic hash discovery is built, capture them by hand:

1. Open https://www.s-kaupat.fi in Chrome or Edge, open DevTools → Network and filter for `api.s-kaupat.fi`.
2. Search for any product. Click the `RemoteFilteredProducts` request and copy `sha256Hash` from the `extensions` query parameter.
3. Open a store list page (for example `/myymalat/prisma`) and click "Näytä lisää". Copy the hash from the `RemoteStoreSearch` request.
4. Put both into the Claude Desktop config above.

When a hash goes stale, tools return the `unsupported` error code with a message saying so. The response parsing has not yet been checked against live traffic; that is the S0 step in the plan.

`get_products` currently searches each ID and matches it exactly, because no by-ID lookup has been mapped yet. A miss is reported as `unknown`, not `not_found`, since a search miss does not prove the product is gone.

## Project layout

```
src/
  index.ts               stdio entry point, picks live or fixture client
  server.ts              MCP tool definitions and error mapping
  errors.ts              stable error codes and their Finnish and English messages
  log.ts                 stderr logger
  client/
    types.ts             domain types and the SKaupatClient interface
    http-client.ts       live S-kaupat GraphQL client
    fixture-client.ts    offline client for tests and demos
  auth/
    session.ts           login state, quiet renewal, cross-process lock
    login-window.ts      the server's own login window
    token-store.ts       Credential Manager and token file storage
    auth-api.ts          S-kaupat token renewal and profile calls
    fixture-auth.ts      pretend login for fixture mode
  test/                  node:test suites (no network)
fixtures/catalogue.json  synthetic sample catalogue
```

The MCP layer depends only on the `SKaupatClient` interface, so the transport chosen in S0 (direct HTTP, managed browser or extension) can replace `http-client.ts` without changing the tools.

## Not included yet

Shopping list and cart tools, stock availability, product detail, automatic hash refresh and packaged releases. See the plan.
