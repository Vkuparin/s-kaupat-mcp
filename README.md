# s-kaupat-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP client (an app, an assistant, Claude) use the [S-kaupat.fi](https://www.s-kaupat.fi) grocery store: find stores, search and browse products, read ingredients and allergens, and fill the user's S-kaupat shopping lists, which the user then turns into a cart with one button on the site.

Status: **early (v0.5.1)**. Catalogue, store-selection, login and shopping list tools. All tools talk to S-kaupat's public API with their own queries, see [Live mode](#live-mode). The roadmap is in [docs/s-kaupat-mcp-plan.md](docs/s-kaupat-mcp-plan.md) and what is known about the S-kaupat API is in [docs/s-kaupat-api.md](docs/s-kaupat-api.md).

## Get it

- **For your own app:** ship the standalone `s-kaupat-mcp.exe` (Node.js inside, nothing else to install), the single-file `s-kaupat-mcp.cjs`, or the npm package with its library API. It runs over stdio or, for apps that can't use stdio, over local HTTP with an access key. See [docs/embedding.md](docs/embedding.md) for packaging and settings, and [docs/caller-guide.md](docs/caller-guide.md) for the user experience.
- **For Claude Desktop:** the one-click extension, see [Install in Claude Desktop](#install-in-claude-desktop-one-click).

All of these are built by the Release workflow in GitHub Actions.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `get_setup_status` | none | For an app's first screen: the chosen store, login status, `canSearch`, `canUseLists`, and `nextStep` (`choose_store`, `log_in` or `null`). Never opens a window |
| `search_stores` | `query` (name, city or postal code), `chain`, `limit`, `includeOpeningHours` | Picker-ready stores: ID, name, chain, address, coordinates, online ordering, today's opening hours, whether it is the selected store |
| `select_store` | `storeId` | Saves the user's store and returns it with opening hours for the coming week |
| `get_selected_store` | none | The saved store with opening hours, or `selectedStore: null` when none is chosen yet |
| `search_products` | `storeId` (optional), `query`, `limit`, `offset`, `sort` (`relevance`, `price_asc`, `price_desc`) | Products in that store: ID (EAN), name, brand, price, regular and campaign price, comparison price and unit, category, labels, shelf location, image URL, observation time |
| `get_products` | `storeId` (optional), `ids[]` (EANs) | One result per ID, from one request: `found` with the product, or `not_found` (not sold in that store, or unknown barcode) |
| `get_product_details` | `productId`, `storeId` (optional) | The product page: everything above plus description, ingredients, allergens (`contains`, `may_contain`, `free_from`), nutrition per 100 g/ml, country of origin, supplier, net weight |
| `list_categories` | `storeId` (optional), `parent` (slug, optional), `depth` (1 to 3) | Category menu in Finnish: `id`, `name`, `slug`, `childCount`, optionally `children` |
| `browse_category` | `slug`, `storeId` (optional), `limit`, `offset`, `sort` | Products in that category, same fields as `search_products` |
| `login_status` | none | `logged_in` (with the account holder's first name), `logged_out` or `expired`. Never opens a window |
| `start_login` | `timeoutSeconds` (30 to 900, default 300) | Opens the server's own small login window and waits: `logged_in`, `cancelled` or `timed_out`, each with a Finnish and English message |
| `get_shopping_lists` | `storeId` (optional) | The user's lists with items, current prices and an estimated total. Needs login |
| `get_shopping_list` | `listId`, `storeId` (optional) | One list. Needs login |
| `create_shopping_list` | `name`, `items[]` (optional), `storeId` (optional) | The new list and, per product, what happened (see below). Needs login |
| `add_to_shopping_list` | `listId`, `items[]` (`productId`, `quantity`, `allowSubstitutes`), `storeId` (optional) | Per product: `added`, `updated`, `unchanged`, `missing` or `uncertain`. Needs login |
| `remove_from_shopping_list` | `listId`, `productIds[]` | The list afterwards, with `removed` and `notOnList`. Needs login |
| `delete_shopping_list` | `listId` | Deletes the whole list. Needs login |

Prices are per store. Product tools use the store chosen with `select_store` unless a `storeId` is passed, and fail with `store_not_selected` when there is neither. Fields S-kaupat does not report come back as `null` (or `"unknown"`) rather than guessed.

Building an app on top of this server? [docs/caller-guide.md](docs/caller-guide.md) walks through first run, login, the store picker, filling a list and showing every error.

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
  "schemaVersion": "0.3",
  "error": {
    "code": "login_required",
    "action": "log_in",
    "retryable": false,
    "message": "No stored S-kaupat login.",
    "userMessage": { "fi": "Kirjaudu ensin S-kaupat-tilillesi.", "en": "Please log in to your S-kaupat account first." }
  }
}
```

Apps should branch on `code` or `action`, never on the message text. `action` says what to offer the user (`log_in`, `finish_login`, `choose_store`, `retry`, `check_list`, `refresh_lists`, `choose_other_product`, `install_browser` or `none`) and `retryable` whether trying again later can help. The codes an app is most likely to act on:

| Code | What the app should do |
|---|---|
| `login_required` | Show a "Log in" button that calls `start_login` |
| `session_expired` | Same: the saved login stopped working, so the user logs in again |
| `login_window_unavailable` | The login window can't open on this device (no Edge or Chrome) |
| `browser_unavailable` | The S-kaupat browser window can't open (no Edge or Chrome) |
| `browser_busy` | Another app's copy of the server has the S-kaupat window open; retry shortly |
| `login_in_progress` | The login window is open; finish logging in first |
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
2. The user opens the list on the S-kaupat site or app, presses *Lisää kaikki ostoskoriin* and checks out there. The first time, the site asks for the store and pickup or home delivery before it fills the cart (the site keeps its own store choice). Every list write returns this as `nextStep` in Finnish and English. The server never places orders or touches payment.

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

- `added` / `updated` / `unchanged`: the product is on the list as requested. `item` names the list row (`itemId`, `name`, `quantity`, `allowSubstitutes`); the full product with its price is in `list.items`. A `warning` means S-kaupat's cart check says it can't be ordered right now; it is still on the list, and `allowSubstitutes` decides what the store does.
- `missing`: not written. `reason` is `unknown_barcode`, `not_sold_in_store`, `no_internal_id` or `write_failed` (then `code` says why, e.g. `session_expired`).
- `uncertain`: S-kaupat did not confirm the write and re-reading the list didn't settle it; ask the user to check the list.
- `estimatedTotal` is in euros at current shelf prices; `complete` is `false` when a price is missing or approximate (weighed goods).

Before writing, the server looks up all products in one request (S-kaupat needs each product's internal id and name for a list row) and runs S-kaupat's anonymous cart check. In `SKAUPAT_MODE=fixtures`, lists are kept in memory after `start_login`, and product `0000000000055` is out of stock, so apps can build the whole flow offline.

Not yet checked against the live site: the exact shape of list reads (written from the website's own query text), and whether S-kaupat accepts the list item fields it showed in a test (`ean`, `sokId`, `name`, `quantity`, `isReplaceable`) from outside the browser. Changing an item's quantity adds a new row and then removes the old one, because S-kaupat's item update input is not mapped yet; if a step fails, the product stays on the list and the result says `uncertain`.

## Install in Claude Desktop (one click)

The easiest way is the extension file, `s-kaupat-<version>.mcpb`. It contains everything, including its own copy of the libraries it needs; Claude Desktop runs it with its built-in Node.js.

1. Get the file: download it from the repository's releases, or build it yourself with `npm run pack:extension` (see below).
2. Open Claude Desktop → **Settings → Extensions** and drag the file in (or use **Advanced settings → Install Extension…** and pick it). Double-clicking the file works only on some setups; if nothing happens, use Settings.
3. Press **Install**. That's it: ask Claude, for example, "Etsi Prisma Tampereelta ja valitse se kaupakseni".

Optional: in the extension's settings, **Demo mode** uses built-in sample stores and products, so you can try it without S-kaupat or a login.

To use shopping lists, ask Claude to log you in to S-kaupat (or use your app's "Log in" button). A small S-kaupat window opens once; Microsoft Edge or Google Chrome must be installed.

To update, install the newer `.mcpb` file the same way. To remove, use the extension's menu in Settings → Extensions.

### Building the extension file

Requires Node.js 20 or newer.

```bash
npm install
npm run pack:extension
```

This builds the server, stages it with only its runtime dependencies in `build/extension`, validates `manifest.json` and writes `s-kaupat-<version>.mcpb` in the repository root. The version comes from `package.json` and must match `manifest.json` (a test checks this and that the manifest lists every tool).

## Development

```bash
npm install
npm run build
npm test
```

Try it interactively with the MCP Inspector:

```bash
npm run inspect
```

What still needs a real PC and account (login, the browser window, live lists) is listed in [docs/interactive-tests.md](docs/interactive-tests.md).

### Claude Desktop from a checkout (developers)

Instead of the extension, you can point Claude Desktop at a checkout: Settings → Developer → Edit Config, then add the server to `claude_desktop_config.json` with the absolute path to `dist/index.js`:

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

Add `"env": { "SKAUPAT_MODE": "demo" }` for offline sample data. On macOS or Linux use a normal path such as `/Users/you/s-kaupat-mcp/dist/index.js`. Restart Claude Desktop after editing the config. Server logs go to stderr and show up in Claude Desktop's MCP logs.

## Configuration

Settings come from command-line flags, environment variables or a JSON config file (`--config <file>`); every setting is listed in [docs/embedding.md](docs/embedding.md#settings). The most used:

| Variable | Default | Meaning |
|---|---|---|
| `SKAUPAT_MODE` | `live` | `demo` serves built-in sample stores and products with no network (`SKAUPAT_DEMO=true` is the extension's Demo mode switch) |
| `SKAUPAT_DATA_DIR` | `%LOCALAPPDATA%\s-kaupat-mcp` on Windows, `~/.config/s-kaupat-mcp` elsewhere | Browser profile, lock files and login file |
| `SKAUPAT_TRANSPORT` | `browser` | `browser` sends API calls from a minimised browser window (see Live mode); `direct` uses plain HTTP |
| `SKAUPAT_DEBUG` | off | `1` logs each API request to stderr (never tokens) |

## Live mode

Every tool sends its own GraphQL query text to `api.s-kaupat.fi`; no persisted-query hashes are needed (see [docs/s-kaupat-api.md](docs/s-kaupat-api.md), section 1). Parsing is tested against responses captured live in `docs/samples/` and `fixtures/api/`.

**The calls come from a browser window.** Since 7 October 2026 S-kaupat's API answers plain scripts with `403`, while it answers its own website. So by default (`SKAUPAT_TRANSPORT=browser`) the server keeps one Microsoft Edge (or Chrome) window with its own profile, started **minimised in the taskbar**, with the S-kaupat site open, and sends each API call from inside that page, the way the website does. It is a normal browser window that does not disguise itself.

- The window opens on the first S-kaupat call and closes itself after 3 minutes without calls. Closing it by hand is fine; the next call opens it again.
- It uses the same profile as the login window (`%LOCALAPPDATA%\s-kaupat-mcp\login-browser` on Windows), so treat that folder like a password. While the login window is open, other tools answer `login_in_progress`.
- Calls go one at a time, at least half a second apart. If S-kaupat refuses a call, the page is reloaded once and the call retried once; after that the tool answers `blocked`.
- Only one copy of the server can have the window open at a time. A second app running its own copy gets `browser_busy` until the first one's window closes.
- `SKAUPAT_TRANSPORT=direct` sends plain HTTP requests instead (faster, no window), in case S-kaupat accepts them again.

If S-kaupat changes its API, a rejected query comes back as `upstream_error`, and the server logs S-kaupat's explanation (which names the changed field) to stderr.

The S-kaupat API is unofficial and undocumented. Use this with your own account for your own shopping; the server never places orders.

## Project layout

```
src/
  index.ts               command line: stdio server
  lib.ts                 library entry point for apps embedding the server
  config.ts              settings from flags, environment and config file
  runtime.ts             builds the live or demo server from the settings
  http.ts                optional local HTTP endpoint with an access key
  demo/catalogue.ts      built-in sample catalogue for demo mode and tests
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
  browser/
    session.ts           the minimised S-kaupat browser window (starts on demand, closes when idle)
    browser-fetch.ts     sends API calls from inside the S-kaupat page, one at a time
    launch.ts            opens the server's own Edge/Chrome profile
  auth/
    session.ts           login state, quiet renewal, cross-process lock
    login-window.ts      the server's own login window
    token-store.ts       Credential Manager and token file storage
    auth-api.ts          S-kaupat token renewal and profile calls
    fixture-auth.ts      pretend login for fixture mode
  test/                  node:test suites (no network)
fixtures/api/            trimmed live API responses used by tests
docs/samples/            live API captures, also parsed by tests
manifest.json            Claude Desktop extension manifest
scripts/pack-extension.mjs    builds the .mcpb extension file
scripts/build-standalone.mjs  builds the single-file executable and JavaScript bundle
.github/workflows/            CI (tests on Windows and Linux) and the release build
```

The MCP layer depends only on the `SKaupatClient` interface, so the transport chosen in S0 (direct HTTP, managed browser or extension) can replace `http-client.ts` without changing the tools.

## Not included yet

Order placement and payment are deliberately left out. See the plan.
