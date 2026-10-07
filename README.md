# s-kaupat-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any MCP client) use the [S-kaupat.fi](https://www.s-kaupat.fi) grocery store: find stores, search products, and fill the user's S-kaupat shopping lists, which the user then turns into a cart with one button on the site.

Status: **early (v0.2.0)**. Catalogue, store-selection, login and shopping list tools. All tools talk to S-kaupat's public API with their own queries, see [Live mode](#live-mode). The roadmap is in [docs/s-kaupat-mcp-plan.md](docs/s-kaupat-mcp-plan.md) and what is known about the S-kaupat API is in [docs/s-kaupat-api.md](docs/s-kaupat-api.md).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_stores` | `query` (name, city or postal code), `chain`, `limit`, `includeOpeningHours` | Picker-ready stores: ID, name, chain, address, coordinates, online ordering, today's opening hours, whether it is the selected store |
| `select_store` | `storeId` | Saves the user's store and returns it with opening hours for the coming week |
| `get_selected_store` | none | The saved store with opening hours, or `selectedStore: null` when none is chosen yet |
| `search_products` | `storeId` (optional), `query`, `limit`, `offset`, `sort` (`relevance`, `price_asc`, `price_desc`) | Products in that store: ID (EAN), name, brand, price, regular and campaign price, comparison price and unit, category, labels, shelf location, image URL, observation time |
| `get_products` | `storeId` (optional), `ids[]` (EANs) | One result per ID, from one request: `found` with the product, or `not_found` (not sold in that store, or unknown barcode) |
| `login_status` | none | `logged_in` (with the account holder's first name), `logged_out` or `expired`. Never opens a window |
| `start_login` | `timeoutSeconds` (30 to 900, default 300) | Opens the server's own small login window and waits: `logged_in`, `cancelled` or `timed_out`, each with a Finnish and English message |
| `get_shopping_lists` | `storeId` (optional) | The user's lists with items, current prices and an estimated total. Needs login |
| `get_shopping_list` | `listId`, `storeId` (optional) | One list. Needs login |
| `create_shopping_list` | `name`, `items[]` (optional), `storeId` (optional) | The new list and, per product, what happened (see below). Needs login |
| `add_to_shopping_list` | `listId`, `items[]` (`productId`, `quantity`, `allowSubstitutes`), `storeId` (optional) | Per product: `added`, `updated`, `unchanged`, `missing` or `uncertain`. Needs login |
| `remove_from_shopping_list` | `listId`, `productIds[]` | The list afterwards, with `removed` and `notOnList`. Needs login |
| `delete_shopping_list` | `listId` | Deletes the whole list. Needs login |

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
| `list_not_found` | The shopping list was deleted (perhaps on the site); show the lists again |
| `unavailable`, `blocked` | S-kaupat is slow or refused; retry a little later |

The full list, with every message, is in [src/errors.ts](src/errors.ts). Invalid arguments are rejected by schema validation before a tool runs.

## Login

Catalogue tools work without logging in. Shopping lists need a login:

1. The app calls `login_status` to show whether the user is logged in, and by which name.
2. When the user presses the app's "Log in" button, the app calls `start_login`. A small S-kaupat window opens; the user logs in as usual, and the window closes by itself. The tool returns once they finish, close the window or the time runs out. It is never opened implicitly by other tools.
3. The server keeps only the S-kaupat **refresh token**: in Windows Credential Manager on Windows, or in a file readable only by the user elsewhere. Access tokens stay in memory and are renewed quietly before they expire. Several apps running the server at once share the login safely: renewal takes a lock and re-reads the saved token first. Tokens are never logged.

The login window uses its own browser profile under the data folder, not your everyday browser, and needs Microsoft Edge or Google Chrome installed (or `SKAUPAT_BROWSER_PATH`). In `SKAUPAT_MODE=fixtures`, `start_login` succeeds at once as user "Testi", so apps can build their login UI offline.

Not yet checked against the live site: which localStorage entry the site keeps its tokens in (the window looks for any stored object with a `refreshToken`), whether `authTokens(refreshToken)` renews outside the browser, and whether S-kaupat rotates refresh tokens.

## Shopping lists

S-kaupat has no server-side cart: the website keeps the cart in the browser. Shopping lists are kept on the user's S-kaupat account, and each list on the site has a **Lisää kaikki ostoskoriin** (add all to cart) button. So the flow is:

1. The app (or Claude) fills a list with `create_shopping_list` or `add_to_shopping_list`.
2. The user opens the list on the S-kaupat site or app, presses *Lisää kaikki ostoskoriin* and checks out there. Every list write returns this as `nextStep` in Finnish and English. The server never places orders or touches payment.

Each item is `{ productId, quantity, allowSubstitutes }`. `quantity` is pieces, or kilograms for products sold by weight. `allowSubstitutes` (default `true`) lets the store pick a similar product if this one is out of stock. A product already on the list gets the new quantity rather than a second row. Prices are from the user's selected store.

A list write returns one result per requested product, so the app can show exactly what happened:

```json
{
  "list": { "id": "…", "name": "Viikonloppu", "itemCount": 2, "estimatedTotal": { "amount": 4.94, "complete": true }, "items": [ … ] },
  "results": [
    { "productId": "6414893386488", "status": "added", "requestedQuantity": 2, "item": { … } },
    { "productId": "6408430000432", "status": "added", "requestedQuantity": 1, "item": { … },
      "warning": { "code": "product_unavailable", "label": "Tilapäisesti loppu", "userMessage": { "fi": "…", "en": "…" } } },
    { "productId": "6400000000000", "status": "missing", "requestedQuantity": 1, "name": null,
      "error": { "code": "product_unavailable", "reason": "unknown_barcode", "userMessage": { "fi": "…", "en": "…" } } }
  ],
  "summary": { "added": 2, "updated": 0, "unchanged": 0, "missing": 1, "uncertain": 0, "withWarnings": 1 },
  "nextStep": { "fi": "Avaa ostoslista S-kaupat-sivulla ja paina \"Lisää kaikki ostoskoriin\". …", "en": "…" }
}
```

- `added` / `updated` / `unchanged`: the product is on the list as requested. A `warning` means S-kaupat's cart check says it can't be ordered right now; it is still on the list, and `allowSubstitutes` decides what the store does.
- `missing`: not written. `reason` is `unknown_barcode`, `not_sold_in_store`, `no_internal_id` or `write_failed` (then `code` says why, e.g. `session_expired`).
- `uncertain`: S-kaupat did not confirm the write and re-reading the list didn't settle it; ask the user to check the list.
- `estimatedTotal` is in euros at current shelf prices; `complete` is `false` when a price is missing or approximate (weighed goods).

Before writing, the server looks up all products in one request (S-kaupat needs each product's internal id and name for a list row) and runs S-kaupat's anonymous cart check. In `SKAUPAT_MODE=fixtures`, lists are kept in memory after `start_login`, and product `0000000000055` is out of stock, so apps can build the whole flow offline.

Not yet checked against the live site: the exact shape of list reads (written from the website's own query text), and whether S-kaupat accepts the list item fields it showed in a test (`ean`, `sokId`, `name`, `quantity`, `isReplaceable`) from outside the browser. Updating an item's quantity is a remove and re-add, because S-kaupat's item update input is not mapped yet.

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
| `SKAUPAT_DATA_DIR` | `%LOCALAPPDATA%\s-kaupat-mcp` on Windows, `~/.config/s-kaupat-mcp` elsewhere | Lock file, token file and the login window's browser profile |
| `SKAUPAT_TOKEN_STORE` | `credential-manager` on Windows, `file` elsewhere | Where the refresh token is kept |
| `SKAUPAT_TOKEN_FILE` | `<data dir>/refresh-token` | Token file path when `SKAUPAT_TOKEN_STORE=file` |
| `SKAUPAT_BROWSER_PATH` | Edge, then Chrome | A Chromium-based browser for the login window |
| `SKAUPAT_LOGIN_URL` | `https://www.s-kaupat.fi/` | Page the login window opens |
| `SKAUPAT_DEBUG` | off | `1` logs each API request to stderr (never tokens) |

## Live mode

Every tool sends its own GraphQL query text to `api.s-kaupat.fi`, which accepts it without login, so live mode needs no configuration and no persisted-query hashes (see [docs/s-kaupat-api.md](docs/s-kaupat-api.md), section 1). Parsing is tested against responses captured live in `docs/samples/` and `fixtures/api/`.

If S-kaupat changes its API, a rejected query comes back as `upstream_error`, and the server logs S-kaupat's explanation (which names the changed field) to stderr. If S-kaupat ever stops accepting query text and only allows the website's own persisted queries, that is the main platform risk described in the API notes.

## Project layout

```
src/
  index.ts               stdio entry point, picks live or fixture client
  server.ts              MCP tool definitions and error mapping
  errors.ts              stable error codes and their Finnish and English messages
  lists/                 shopping list types and the list write flow (per-item results)
  selection.ts           remembers the user's chosen store (settings file)
  stores.ts              chain names and opening-hours helpers
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
fixtures/api/            trimmed live API responses used by tests
```

The MCP layer depends only on the `SKaupatClient` interface, so the transport chosen in S0 (direct HTTP, managed browser or extension) can replace `http-client.ts` without changing the tools.

## Not included yet

Product detail, categories and packaged releases. Order placement and payment are deliberately left out. See the plan.
