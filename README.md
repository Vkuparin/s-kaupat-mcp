# s-kaupat-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) browse the [S-kaupat.fi](https://www.s-kaupat.fi) grocery catalogue: find stores, search products and refresh exact products by ID.

Status: **early scaffold (v0.1.0)**. Catalogue tools only; no login or cart yet. Live access to S-kaupat is unverified, see [Live mode](#live-mode). The roadmap is in [docs/s-kaupat-mcp-plan.md](docs/s-kaupat-mcp-plan.md) and what is known about the S-kaupat API is in [docs/s-kaupat-api.md](docs/s-kaupat-api.md).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_stores` | `query` (name, city or postal code), `limit` | Stores with IDs, chain, address |
| `search_products` | `storeId`, `query`, `limit` | Products in that store: ID (EAN), name, brand, price, campaign price, comparison price and unit, price basis, observation time |
| `get_products` | `storeId`, `ids[]` | One result per ID: `found` with the product, `not_found`, or `unknown` |

Prices are per store, so product tools always take a `storeId` from `search_stores`. Fields S-kaupat does not report come back as `null` (or `"unknown"`) rather than guessed.

Every result carries `schemaVersion`. Failures come back as MCP tool errors (`isError: true`) with a stable code:

```json
{ "schemaVersion": "0.1", "error": { "code": "unavailable", "message": "Store 123 was not found.", "storeId": "123" } }
```

Codes in use now: `unavailable`, `blocked`, `unsupported`, `upstream_error`. Invalid arguments are rejected by schema validation before a tool runs. The cart-related codes from the plan are reserved.

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
| `SKAUPAT_DEBUG` | off | `1` logs each API request to stderr |

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
  errors.ts              stable error codes
  log.ts                 stderr logger
  client/
    types.ts             domain types and the SKaupatClient interface
    http-client.ts       live S-kaupat GraphQL client
    fixture-client.ts    offline client for tests and demos
  test/                  node:test suites (no network)
fixtures/catalogue.json  synthetic sample catalogue
```

The MCP layer depends only on the `SKaupatClient` interface, so the transport chosen in S0 (direct HTTP, managed browser or extension) can replace `http-client.ts` without changing the tools.

## Not included yet

Login, cart tools, stock availability, product detail, automatic hash refresh and packaged releases. See the plan.
