# S-kaupat API map

Research date: 7 October 2026. Read-only; no account, no credentials, no cart.

## How this was researched, and what is not yet verified

Direct requests to `www.s-kaupat.fi` and `api.s-kaupat.fi` were refused by the network policy of both the cloud environment and the desktop workspace, so **nothing below was observed live**. Every claim comes from reading the source of [p18a/mcp-ruoka](https://github.com/p18a/mcp-ruoka) at commit `ef37b32` (16 April 2026), file [`src/browser/s-kaupat.ts`](https://github.com/p18a/mcp-ruoka/blob/ef37b32d5fc8ad127a49787454b873912a7f72a2/src/browser/s-kaupat.ts), which calls the API in production. Treat field names as "worked in April 2026". Section 6 lists the gaps and a 10-minute DevTools check that closes most of them.

## 1. Transport

| Item | Value |
|---|---|
| Endpoint | `https://api.s-kaupat.fi/` (single GraphQL endpoint) |
| Method | `GET`, everything in the query string |
| Query params | `operationName`, `variables` (JSON string), `extensions` (JSON string) |
| Query text | Never sent. Apollo **persisted queries**: `extensions={"persistedQuery":{"version":1,"sha256Hash":"<hash>"}}` |
| Auth | None for catalogue and store data |
| Response | Standard GraphQL `{ "data": ..., "errors": [...] }` |

### Headers mcp-ruoka sends (works without cookies)

```
Origin: https://www.s-kaupat.fi
Referer: https://www.s-kaupat.fi/
User-Agent: <desktop Chrome UA>
Accept: application/json
```

No API key, token or cookie is sent. Unlike K-Ruoka, mcp-ruoka needs no stealth browser or Cloudflare handling for S-kaupat API calls; plain `fetch` works.

### Persisted query hashes

The server only accepts hashes it already knows (the hash is the SHA-256 of the website's query text). Hashes **change when s-kaupat.fi deploys new query text**. When a hash is stale the API returns:

```json
{ "errors": [ { "extensions": { "code": "PERSISTED_QUERY_NOT_FOUND" } } ] }
```

mcp-ruoka handles this by launching headless Chromium, visiting site pages, intercepting requests to `api.s-kaupat.fi/**`, and reading `sha256Hash` out of the `extensions` param per `operationName`. It refreshes on `PERSISTED_QUERY_NOT_FOUND` and retries once.

Pages it visits to trigger each operation:

| Operation | Page that fires it |
|---|---|
| `RemoteFilteredProducts` | `https://www.s-kaupat.fi/hakutulokset?queryString=test` |
| `RemoteStoreSearch` | `https://www.s-kaupat.fi/myymalat/prisma`, then clicking "Näytä lisää" (cookie banner `#usercentrics-root` removed first) |

Untested alternative worth trying: Apollo servers often accept full query text (`POST` with `query`) or Automatic Persisted Query registration. If S-kaupat allows either, the browser dependency disappears. If not, an alternative to a browser is to fetch the site's JS bundles and extract the query strings/hashes.

## 2. Product search: `RemoteFilteredProducts`

Variables:

```json
{ "queryString": "maito", "storeId": "<store id>", "from": 0, "limit": 24 }
```

Search is **per store**: `storeId` is required, so prices and availability are store-specific. `from`/`limit` paginate.

Response fields mcp-ruoka relies on (`data.store.products`):

```
total: number
productListItems[]:
  product:
    name, ean, price (nullable), brandName (nullable)
    pricing: currentPrice, comparisonPrice, comparisonUnit, campaignPrice (all nullable)
    productDetails.productImages.mainImage.urlTemplate (nullable)
    hierarchyPath[]: name      // category path, [0] = top level
```

- Product identity is the **EAN**.
- Price: use `pricing.currentPrice`, fall back to `price`. `campaignPrice` is the offer price.
- Unit price: `comparisonPrice` + `comparisonUnit` (e.g. `KG`, `L`).
- Images: `urlTemplate` contains `{MODIFIERS}` and `{EXTENSION}` placeholders, e.g. replace with `w_200,h_200` and `png`.

The real response almost certainly has more fields (the persisted query decides them); mcp-ruoka only parses these.

## 3. Store search: `RemoteStoreSearch`

Variables:

```json
{ "query": "Tampere", "brand": null, "cursor": null }
```

- `query`: free text (city works), or `null` for all stores.
- `brand`: chain filter, `null` for all. Allowed values not confirmed (likely Prisma, S-market, Sale, Alepa…).
- Cursor pagination: pass back `cursor` until it is `null`.

Response (`data.searchStores`): `totalCount`, `cursor`, `stores[]` with `id`, `name`, `location.address.postcodeName.default` (city).

The store `id` is what `RemoteFilteredProducts` takes as `storeId`.

## 4. Rate limits and terms

- No rate-limit headers or documented limits found in the source. mcp-ruoka uses a 15 s timeout, caches the full store list in memory, and caps store pagination at 50 pages. It does not throttle.
- The API is undocumented and unofficial; S Group can change it without notice. Keep request rates human-like, cache store lists, and check S-kaupat terms of use before distributing.

## 5. Implications for s-kaupat-mcp

1. Catalogue (search, prices, stores) is reachable with plain HTTP once hashes are known. That is the easy part.
2. Hash management is the main maintenance cost. Design for automatic refresh and a clear error when refresh fails.
3. Nothing here covers **product detail by EAN, availability/stock, cart, login, or order history**. Those need their own operations, captured from the logged-in site, and are what the S0 gate in [s-kaupat-mcp-plan.md](s-kaupat-mcp-plan.md) is about.

## 6. Open questions and how to close them

Open in a normal browser, DevTools → Network, filter `api.s-kaupat.fi`, then:

| Action on s-kaupat.fi | Record |
|---|---|
| Search "maito" | Confirm `RemoteFilteredProducts` variables and full response; note any sort/filter variables |
| Open one product page | Operation name for product detail, variables (EAN? slug? storeId?), stock/availability fields |
| Change store | How the selected store is stored (cookie? localStorage?) and passed |
| Browse a category | Category tree operation and variables |
| Store list / store page | `RemoteStoreSearch` brands; opening hours operation |
| Add one item to cart while logged out | Cart operation names, whether cart is anonymous and where its id lives (do not complete checkout) |
| Log in (optional, your own account) | Auth mechanism (cookie vs bearer token), which operations need it |
| Any response | Rate-limit or cache headers (`x-ratelimit-*`, `retry-after`, `cache-control`) |

Also try one `POST https://api.s-kaupat.fi/` with a plain `query` body to see if non-persisted queries are allowed, and check response headers for the Apollo/GraphQL server type.

To let Claude probe directly instead, add `s-kaupat.fi` and `api.s-kaupat.fi` to the project's cloud environment allowed domains.
