# s-kaupat-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) browse the [S-kaupat.fi](https://www.s-kaupat.fi) grocery catalogue: find stores, search products and refresh exact products by ID.

Status: **early (v0.1.0)**. Catalogue and store-selection tools only; no login or shopping lists yet. All tools talk to S-kaupat's public API with their own queries, see [Live mode](#live-mode). The roadmap is in [docs/s-kaupat-mcp-plan.md](docs/s-kaupat-mcp-plan.md) and what is known about the S-kaupat API is in [docs/s-kaupat-api.md](docs/s-kaupat-api.md).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_stores` | `query` (name, city or postal code), `chain`, `limit`, `includeOpeningHours` | Picker-ready stores: ID, name, chain, address, coordinates, online ordering, today's opening hours, whether it is the selected store |
| `select_store` | `storeId` | Saves the user's store and returns it with opening hours for the coming week |
| `get_selected_store` | none | The saved store with opening hours, or `selectedStore: null` when none is chosen yet |
| `search_products` | `storeId` (optional), `query`, `limit`, `offset`, `sort` (`relevance`, `price_asc`, `price_desc`) | Products in that store: ID (EAN), name, brand, price, regular and campaign price, comparison price and unit, category, labels, shelf location, image URL, observation time |
| `get_products` | `storeId` (optional), `ids[]` (EANs) | One result per ID, from one request: `found` with the product, or `not_found` (not sold in that store, or unknown barcode) |

Prices are per store. Product tools use the store chosen with `select_store` unless a `storeId` is passed, and fail with `store_not_selected` when there is neither. Fields S-kaupat does not report come back as `null` (or `"unknown"`) rather than guessed.

### Store picker flow for apps

1. On start, call `get_selected_store`. If `selectedStore` is `null`, show a store picker.
2. Ask for a city, store name or postal code and call `search_stores` with it (optionally with `chain`, e.g. `PRISMA`). Each store has `name`, `chainName`, `street`, `postalCode`, `city` and `openingHoursToday` ready to show; `coordinates` lets the app sort by distance.
3. When the user taps a store, call `select_store` with its `id`. The choice is saved to a settings file and survives restarts.
4. Product searches now run in that store. If a product tool returns `store_not_selected` or `store_not_found`, show the picker again.

A store in a result looks like this:

```json
{
  "id": "517609418",
  "name": "Prisma Kaleva Tampere",
  "chain": "PRISMA",
  "chainName": "Prisma",
  "street": "Sammonkatu 75",
  "postalCode": "33540",
  "city": "Tampere",
  "coordinates": { "lat": 61.492234, "lon": 23.819213 },
  "onlineOrdering": true,
  "isSelected": false,
  "openingHoursToday": { "date": "2026-10-07", "day": "WED", "status": "open_24h", "ranges": [] }
}
```

Opening hours `status` is `open` (see `ranges`, local Finnish time; a close of `00:00` means midnight), `open_24h`, `closed` or `unknown`. `openingHoursToday` is `null` when S-kaupat did not report hours. `onlineOrdering` is read from S-kaupat's store `domains` and is not yet confirmed to mean online ordering.

Every result carries `schemaVersion`. Failures come back as MCP tool errors (`isError: true`) with a stable code, an English `message` and, for errors meant for end users, a Finnish `messageFi`:

```json
{ "schemaVersion": "0.2", "error": { "code": "store_not_selected", "message": "Choose your store first.", "messageFi": "Valitse ensin oma kauppasi." } }
```

Codes in use now: `store_not_selected`, `store_not_found`, `unavailable`, `blocked`, `unsupported`, `upstream_error`. Invalid arguments are rejected by schema validation before a tool runs. The cart-related codes from the plan are reserved.

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

Live S-kaupat (no configuration needed):

```json
{
  "mcpServers": {
    "s-kaupat": {
      "command": "node",
      "args": ["D:\\AIstuff\\repos\\s-kaupat-mcp\\dist\\index.js"]
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
| `SKAUPAT_SETTINGS_FILE` | `%APPDATA%\s-kaupat-mcp\settings.json` on Windows, `~/.config/s-kaupat-mcp/settings.json` elsewhere | Where the selected store is saved (no credentials) |
| `SKAUPAT_DEBUG` | off | `1` logs each API request to stderr |

## Live mode

Every tool sends its own GraphQL query text to `api.s-kaupat.fi`, which accepts it without login, so live mode needs no configuration and no persisted-query hashes (see [docs/s-kaupat-api.md](docs/s-kaupat-api.md), section 1). Parsing is tested against responses captured live in `docs/samples/` and `fixtures/api/`.

If S-kaupat changes its API, a rejected query comes back as `upstream_error`, and the server logs S-kaupat's explanation (which names the changed field) to stderr. If S-kaupat ever stops accepting query text and only allows the website's own persisted queries, that is the main platform risk described in the API notes.

## Project layout

```
src/
  index.ts               stdio entry point, picks live or fixture client
  server.ts              MCP tool definitions and error mapping
  errors.ts              stable error codes
  selection.ts           remembers the user's chosen store (settings file)
  stores.ts              chain names and opening-hours helpers
  log.ts                 stderr logger
  client/
    types.ts             domain types and the SKaupatClient interface
    http-client.ts       live S-kaupat GraphQL client
    fixture-client.ts    offline client for tests and demos
  test/                  node:test suites (no network)
fixtures/catalogue.json  synthetic sample catalogue
fixtures/api/            trimmed live API responses used by tests
```

The MCP layer depends only on the `SKaupatClient` interface, so the transport chosen in S0 (direct HTTP, managed browser or extension) can replace `http-client.ts` without changing the tools.

## Not included yet

Login, shopping lists, stock availability, product detail, categories and packaged releases. See the plan.
