# S-kaupat API map

Research dates: 7 October 2026 (source reading), 7–8 October 2026 (live verification). Read-only; no account, no credentials, no cart.

## How this was researched

Two passes:

1. **Source reading.** [p18a/mcp-ruoka](https://github.com/p18a/mcp-ruoka) at commit `ef37b32` (16 April 2026), file [`src/browser/s-kaupat.ts`](https://github.com/p18a/mcp-ruoka/blob/ef37b32d5fc8ad127a49787454b873912a7f72a2/src/browser/s-kaupat.ts).
2. **Live verification** from a desktop machine: about 25 anonymous requests to `https://api.s-kaupat.fi/`, spaced roughly 10 s apart, no cookies, no login. Sample requests and responses are in [samples/](samples/).
3. **Site bundle reading** (8 October 2026) in the owner's own logged-in Chrome: one page load of `/hakutulokset?queryString=maito`, then the GraphQL documents were reconstructed from the page's JS bundles and the persisted-query hashes read from the page's own requests. No cart, order, list or account action was performed; no token, cookie or personal data was read or saved. Result: `samples/site-operations.graphql` (119 operations, 72 fragments; **kept local only and git-ignored**, because it is S Group's own query text; it can be regenerated locally from the site bundle by walking the `kind:"OperationDefinition"` / `kind:"FragmentDefinition"` ASTs in the page's scripts) and [samples/site-persisted-hashes.json](samples/site-persisted-hashes.json).
4. **Shopping-list write test** (8 October 2026), with the owner's explicit go-ahead, in the same logged-in browser through the site's own UI: created one list, added one product, read it back, deleted the list. Only operation names, variable shapes and header names were recorded: [samples/shopping-list-writes.json](samples/shopping-list-writes.json). Plus two more anonymous calls (availability with a date, `validateCart`).

Status markers used below:

- ✅ **verified live** — observed in a real response on 7–8 October 2026.
- 🟡 **schema-verified** — the server's validator accepted the field/argument name, but no value was observed or the semantics are a guess.
- 📦 **from site bundle** — read from the website's own query text; exact names and shapes, but not executed by us.
- ❌ **not verified** — from source reading or inference only.

### Website bot protection

`https://www.s-kaupat.fi/` (every path tried: `/`, `/robots.txt`, `/hakutulokset`) answers plain HTTP clients with `429` and `X-Vercel-Mitigated: challenge`, i.e. a Vercel bot challenge. That challenge was not worked around; the site's bundles were instead read from a normal logged-in browser session (pass 3). Consequences:

- A headless client cannot fetch the site's bundles or hashes unattended. mcp-ruoka's hash-refresh approach (headless Chromium visiting `www.s-kaupat.fi`) has to get through that challenge, so it may no longer work.
- This does not matter for the API: the API host has no challenge and accepts arbitrary query text (section 1), so hashes are not needed at all.
- Only the chunks loaded on the search page were scanned. Operations used solely on other pages (e.g. `RemoteStoreSearch` on the store pages, checkout-only operations) are missing from the dump.

## 1. Transport

| Item | Value | Status |
|---|---|---|
| Endpoint | `https://api.s-kaupat.fi/` (single GraphQL endpoint) | ✅ |
| Server | Apollo Server behind AWS CloudFront (`Via: … cloudfront.net`, `x-amzn-RequestId`, HEL edge) | ✅ |
| Methods | `GET` and `POST` (`access-control-allow-methods: OPTIONS, POST, GET`) | ✅ |
| **Full query text** | **Accepted**, both `POST` JSON body `{operationName, variables, query}` and `GET ?query=…` | ✅ |
| Persisted queries | Apollo APQ. Unknown hash → `PERSISTED_QUERY_NOT_FOUND`. **Registration is open**: `POST` with `query` + `extensions.persistedQuery.sha256Hash` registers it, after which a hash-only `GET` works | ✅ |
| Introspection | Disabled (`INTROSPECTION_DISABLED`, HTTP 400) | ✅ |
| Auth | None for catalogue and store data. No cookies needed | ✅ |
| `Origin` / `Referer` | Not required; a `POST` with both empty still returned data | ✅ |
| Bot protection on API host | None seen (plain `curl` and Python `urllib` both work) | ✅ |
| Response | Standard GraphQL `{ "data": …, "errors": […] }` | ✅ |

Minimal working call:

```bash
curl -s https://api.s-kaupat.fi/ -H "Content-Type: application/json" \
  --data '{"query":"{ store(id: \"517609418\") { id name brand } }"}'
```

### Consequence: no browser, no hash scraping

Because the server accepts our own query text, **s-kaupat-mcp can ship its own queries** and select exactly the fields it needs. The hash-refresh machinery in mcp-ruoka (headless Chromium, `PERSISTED_QUERY_NOT_FOUND` retry) is unnecessary. If S Group later locks the endpoint down to an allow-list of hashes, that design would have to come back; treat it as the main platform risk.

The operation name is free-form when you send query text; the names used in this doc (`RemoteFilteredProducts`, `RemoteStoreSearch`) are the website's, the others (`RemoteProductInfo`, `RemoteStoreInfo`, …) are made up here.

### Schema discovery without introspection

Validation errors name the real type and say whether a field exists, e.g. `Cannot query field "openingHours" on type "StoreInfo"` or `Field "weeklyOpeningHours" of type "[StoreWeeklyOpeningTime!]" must have a selection of subfields`. Enum and argument errors sometimes add `Did you mean …`. Everything in section 7 was mapped this way. A query with any invalid field is rejected whole (HTTP 400) and nothing executes.

### Response headers ✅

```
content-type: application/json; charset=utf-8
cache-control: <varies, see below>
vary: accept-language
access-control-allow-origin: https://www.s-kaupat.fi
access-control-allow-credentials: true
access-control-allow-methods: OPTIONS, POST, GET
access-control-allow-headers: authorization,content-type,x-amz-date,x-amz-security-token,x-amz-user-agent,x-api-key,x-client-name,x-client-version,x-skaupat-tags,x-order-access-token,x-vercel-id
strict-transport-security: max-age=63072000; includeSubDomains; preload
x-correlation-id / x-amzn-RequestId / X-Amzn-Trace-Id
X-Cache: Miss from cloudfront | Hit from cloudfront
Via: 1.1 <id>.cloudfront.net (CloudFront)
```

`cache-control` observed per query:

| Query | `cache-control` |
|---|---|
| `store { id name brand }` | `max-age=3600, public` |
| `product(id, storeId)` detail | `max-age=900, public` |
| `store.products` search / category | `max-age=900, private` |
| `searchStores`, store with opening hours/navigation | `no-store` |
| Errors (`PERSISTED_QUERY_NOT_FOUND`, validation) | `no-store` |

A repeated identical `GET` came back `X-Cache: Hit from cloudfront` with `Age: 10`, so **GETs are edge-cached**; prefer `GET` (ideally hash-only after registering) for cacheable lookups. `vary: accept-language` suggests language-dependent content, not tested 🟡.

The allowed request headers hint at what authenticated calls use: `authorization` (bearer token, presumably), `x-order-access-token`, `x-client-name`, `x-client-version`, `x-api-key` ❌ (not exercised).

## 2. Product search and category browsing: `store.products`

✅ Sample: [samples/product-search.json](samples/product-search.json), [samples/category-browse.json](samples/category-browse.json).

```graphql
query RemoteFilteredProducts($storeId: ID!, $queryString: String, $slug: String,
                             $from: Int, $limit: Int, $orderBy: SortKey, $order: SortOrder) {
  store(id: $storeId) {
    id
    name
    products(queryString: $queryString, slug: $slug, from: $from, limit: $limit,
             orderBy: $orderBy, order: $order) {
      total from limit searchProvider
      productListItems { product { ...fields from section 7... } }
    }
  }
}
```

Search is **per store**: prices, shelf location and assortment are store-specific.

Arguments of `Store.products`:

| Argument | Type | Status | Notes |
|---|---|---|---|
| `queryString` | `String` | ✅ | Free text. `"maito"` in Prisma Kaleva → `total: 1312` |
| `slug` | `String` | ✅ | **Category browsing.** Full category path, e.g. `maito-munat-ja-rasvat/maidot-ja-piimat/maidot` → `total: 29` |
| `from`, `limit` | `Int` | ✅ | Offset pagination; echoed back in the response |
| `orderBy` | `SortKey` | ✅ | `price` works. Other enum values unknown |
| `order` | `SortOrder` | ✅ | `asc`, `desc` (lowercase enum values) |
| `eans` | `[String!]` | ✅ | Batch lookup by EAN, see section 3 |
| `hierarchyId` | ? | 🟡 | Exists; presumably category id (e.g. `Herkku_00000006`) |
| `filters` | list | 🟡 | Exists; element shape unknown |
| `searchProvider` | `SearchProvider` enum | 🟡 | Response reports `"loop54"` (Loop54 search engine) |
| `includeAgeLimitedByAlcohol`, `useRandomId`, `generatedSessionId`, `loop54DirectSearch`, `fallbackToGlobal` | — | 🟡 | Exist; not needed for anonymous search |

Response `ProductList`: `total`, `from`, `limit`, `searchProvider`, `productListItems[].product`, and `structuredFacets` (interface `IStructuredFacet` with `key`; concrete types `ObjectFacet`, `StringFacet`; returned `[]` in the calls made) 🟡.

Notes:

- Product identity is the **EAN**; `id` equals `ean` in every product seen ✅.
- Price: `pricing.currentPrice` (equals `price`). `pricing.campaignPrice` is the offer price (null when none), `pricing.regularPrice` the normal price, `lowest30DayPrice` and `campaignPriceValidUntil` exist (null in samples) ✅.
- Unit price: `comparisonPrice` + `comparisonUnit`. Observed unit: `LTR` (not `L`) ✅.
- Images: `productDetails.productImages.mainImage.urlTemplate`, e.g. `https://cdn.s-cloud.fi/v1/{MODIFIERS}/assets/dam-id/<id>.{EXTENSION}`. Placeholders confirmed ✅; substituting e.g. `w_200,h_200` / `png` comes from mcp-ruoka and was not fetched ❌.
- `hierarchyPath[]` is ordered **leaf first, top level last** (the earlier version of this doc had it the wrong way round) ✅. Each entry has `id`, `name`, and a full-path `slug` usable directly as the `slug` argument.
- `location { aisle shelf module floor }` gives the in-store shelf position ✅.

## 3. Product detail by EAN

✅ Sample: [samples/product-detail.json](samples/product-detail.json), [samples/products-by-eans.json](samples/products-by-eans.json).

Single product:

```graphql
query RemoteProductInfo($id: ID!, $storeId: ID!) {
  product(id: $id, storeId: $storeId) { ...fields... }
}
```

- `id` is the EAN. Both arguments are `ID!` (required). `ean:` and `slug:` are **not** arguments of `Query.product`.
- Adds over the list view: `description`, `ingredientStatement`, `nutrients[] { name value ri kcal }`, `allergens[] { allergenTypeCode allergenTypeText levelOfContainmentCode }`, `countryName { fi }`, `supplierName`, `measurement { netWeight grossWeight pceApproxWeight }`. (These fields are also selectable in list queries.)

Several products at once (good for pricing a shopping list in one call):

```graphql
query RemoteProductsByEans($storeId: ID!, $eans: [String!]) {
  store(id: $storeId) { products(eans: $eans) { total productListItems { product { ean name price } } } }
}
```

### Availability / stock

- Anonymous calls without a date: `Product.availability { label date }` was `null` for every product ✅.
- The website asks for it **with a date** 📦: `availability(date: $availabilityDate) { date label labelText availableQuantity }`, and per-store data via `Product.store(storeId: $storeId) { sokId pricing(date: $availabilityDate) { … } labels(date: $availabilityDate) { labelType labelText color backgroundColor } }`. `availabilityDate` is the chosen delivery/pickup date. Called anonymously with `date: "2026-10-09"` ✅ ([samples/availability-with-date.json](samples/availability-with-date.json)): `store { sokId pricing labels }` returned data, while `availability` was still `null` and `labels` `[]` for two ordinary in-stock products. Working assumption: **null availability and no labels means no known problem**; a label appears only when something is limited or unavailable 🟡.
- `Product.inStore` (presumably "sold in the physical store") and `Product.replacements(storeId, availabilityDate) { enabled products { rank product } }` exist 📦.
- The real stock check before ordering is `validateCart` (section 5), which works anonymously ✅.
- No `inStock`/`stock`/`isAvailable` field exists on `Product` ✅.

Other product fields seen only in the site's queries 📦: `sokId` (S Group's internal product id, used alongside EAN), `productType`, `packagingLabelCodes`, `consumerPackageUnit`, `countryOfOrigin`, `countryOfMainRawMaterial`, `productDetails.safetyInformation`, `productDetails.productImages { modifiersString extensionString mainImage mobileReadyHeroImage variableImages }`, `pricing.quantityMultiplier`, `pricing.primaryDiscountRule { id terms termsShort }`. `ProductList` also exposes `items` (plain `Product` list) besides `productListItems`, and `products` takes `sokIds`, `structuredFacets`, `fetchSponsoredContent`, `marketingId`, `sortForAvailabilityLabelDate`.

## 4. Stores

### Store search: `searchStores` ✅

Sample: [samples/store-search.json](samples/store-search.json), [samples/store-search-brand.json](samples/store-search-brand.json).

```graphql
query RemoteStoreSearch($query: String, $brand: StoreBrand, $cursor: String) {
  searchStores(query: $query, brand: $brand, cursor: $cursor) {
    totalCount
    cursor
    stores {
      id name brand slug domains
      location { address { street { default } postcode postcodeName { default } }
                 coordinates { lat lon } }
      services { code name { default sv en } }
    }
  }
}
```

- `query`: free text; `"Tampere"` → 31 stores. `null` → all stores, `totalCount: 1048`.
- `brand`: enum `StoreBrand`. Accepted values: `PRISMA` (85 stores), `EPRISMA`, `S_MARKET`, `SALE`, `ALEPA`, `ABC`, `HERKKU`, `SOKOS_HERKKU`, `MESTARIN_HERKKU`. There may be more. Note the response field `brand` is a lowercase string (`"prisma"`, `"abc"`), not the enum spelling.
- Pagination: 24 stores per page; pass `cursor` back until it is `null`. The cursor is base64 JSON (`{"preference": …, "sort": [name, uuid]}`), opaque in practice. Following a cursor to page 2 was not itself exercised 🟡.
- Result type is `StoreInfo` (lighter than `Store`): no opening hours here.
- `coordinates.lat` / `lon` are **strings**.
- `domains` is `["S_KAUPAT"]` for some stores and `[]` for others; likely marks stores with online grocery ordering 🟡.
- `Query.stores` also exists 🟡 (arguments unknown).

The store `id` (numeric string, e.g. `517609418` = Prisma Kaleva, Tampere) is the `storeId` everywhere else.

### Store details and opening hours: `store(id)` ✅

Sample: [samples/store-info.json](samples/store-info.json), [samples/store-opening-hours.json](samples/store-opening-hours.json).

```graphql
query RemoteStoreInfo($id: ID!) {
  store(id: $id) {
    id name shortName brand slug coOperative
    weeklyOpeningHours { weekNumber openingTimes { date day mode ranges { open close } } }
    contactInfo { email phoneNumber { number callChargeGroup callCharge { default sv en } } }
    services { code name { default sv en } }
  }
}
```

- `weeklyOpeningHours`: three ISO weeks (current + 2), seven `openingTimes` each.
- `day`: `MON`…`SUN`. `date`: `YYYY-MM-DD`.
- `mode`: `ALL_DAY` (24 h, `ranges: null`) or `RANGE` with `ranges: [{ "open": "06:00", "close": "00:00" }]`. A closed-day mode surely exists but was not seen ❌. `openingTimes.message { … }` (type `LocalizedText`) exists for exceptions 🟡.
- `LocalizableText` has `default`, `fi`, `sv`, `en`; Finnish text is in `default` and `fi` was `null`.

### Category tree: `store.navigation` ✅

```graphql
query RemoteNavigation($id: ID!) {
  store(id: $id) { navigation { id name slug children { id name slug children { id name slug } } } }
}
```

- Per store. Prisma Kaleva: 31 top-level items, three levels deep (e.g. `maito-munat-ja-rasvat` → 9 children → 50 grandchildren).
- `NavigationItem` fields: `id`, `name`, `slug`, `children`. `slug` is the full path and feeds `products(slug:)` directly.
- The full three-level tree is about 160 KB; fetch once per store and cache.
- No root-level `categories` or `navigation` query exists; the tree is only reachable through a store.

## 5. Cart, auth, lists, orders 📦

Everything in this section comes from the site's own query text in the local-only `samples/site-operations.graphql`. **None of it was executed by us**; argument and field names are exact, behaviour is inferred.

### Auth

- Tokens are OAuth-style: `accessToken`, `refreshToken`, `idToken`, kept in the browser's local Apollo state (`authenticationTokens @client`).
- Refresh is a server query: `GetRemoteAuthenticationTokens($refreshToken) { authTokens(refreshToken: $refreshToken) { accessToken idToken refreshToken } }`.
- Authenticated calls send the access token in `authorization`, with no `Bearer` prefix ✅. It is a JWT (HS256) issued by `https://authorization.voikukka.fi`, valid about 14 days (`exp` − `iat`), with a separate `sIdExp` roughly one hour after `iat` (probably the S-ID session behind it) ✅. It carries the customer's name and id in its claims, so treat it as personal data.
- In the browser the session lives in `localStorage` (keys such as `session-storage`, `customer-storage`); the only script-readable cookie is `s-kaupat-selected-store` ✅. Values were not read.
- The interactive login (S-käyttäjätili) happens outside this API and was not examined ❌. Whether `authTokens(refreshToken)` works from outside the browser, and whether refresh tokens rotate, is untested ❌.
- User data: `userProfile { firstName lastName email phoneNumber userId customerType address {…} company {…} membershipNumber … }`, `bonusInfo { membershipNumber }`, `userPaymentCards(storeId) { cards { id maskedCardNumber … } defaultPaymentCardId }`.

### Cart: there is no server-side cart

There is no add-to-cart mutation. The cart lives in the browser (`localCartItems @client { ean quantity replace additionalInfo basicQuantityUnit type }`, `domainOrder @client`, `cartTotal @client`). The server is only involved to:

- validate: `validateCart(partialCartItems: [PartialCartItemInput!]!, storeId: ID!, deliveryDate, orderId, slotId, areaId) { isOrderingPossible cartValidationItems { ean availableQuantity labels validationError { … } product } }`. Error types: `ProductAvailabilityError`, `ProductNotFoundError`, `ProductNotInAssortmentError`, `AlcoholSellingError`, `ProductDoesNotFitRobotError`. It is a **query**, so it is the natural read-only check for "can this basket be ordered from this store on this date". **Verified anonymously** ✅ ([samples/validate-cart.json](samples/validate-cart.json)): `PartialCartItemInput` is `{ ean: String!, itemCount: String! }` (count is a string); a real EAN came back with `validationError: null`, a made-up EAN with `ProductNotFoundError`, and `isOrderingPossible: false` for the basket as a whole. Result item ids are `<storeId>-<ean>`;
- create the order: `createOrder(order: OrderInput)`.

Consequence for the MCP: "add to cart" cannot be done through the API in a way the website would show, because the website's cart is local browser state. The server-side things an MCP can write are **shopping lists**, **favourites** and **orders**.

### Shopping lists (server-side, per user)

| Operation | Field |
|---|---|
| `RemoteGetUserLists` | `shoppingLists { id name createdAt items { id ean sokId quantity isReplaceable commentForPicker name product(storeId) } }` |
| `RemoteGetUserListById` | `shoppingList(id)` |
| `RemoteCreateUserList` / `…WithProducts` | `createShoppingList(name, items: [ShoppingListItemInput!])` |
| `RemoteAddToShoppingList` | `createShoppingListItem(shoppingListId, item: ShoppingListItemInput!)` |
| `UpdateShoppinglistItem` | `updateShoppingListItem(shoppingListId, id, item: UpdateShoppingListItemInput!)` |
| `RemoteRemoveShoppingListItem` | `deleteShoppingListItem(shoppingListId, itemId)` |
| `UpdateShoppinglist`, `RemoteDuplicateShoppinglist`, `RemoteRemoveUserList` | `updateShoppingList(id, name)`, `duplicateShoppingList(id, name)`, `deleteShoppingList(id)` |
| `RemoteSetListItemsReplaceability` | `setListItemsReplaceability(shoppingListId, isReplaceable)` |

**Verified live** ✅ through the site's UI (pass 4, [samples/shopping-list-writes.json](samples/shopping-list-writes.json)): create list → add item → read back → delete list all returned 200.

- `ShoppingListItemInput` is `{ ean: String!, sokId: String!, name: String!, quantity: Float!, isReplaceable: Boolean! }`, all required. So a list write needs the product's `sokId` and `name` as well as its EAN; fetch them with `products(eans:)` first.
- `UpdateShoppingListItemInput` exists; its fields were not mapped ❌.
- The site sends list writes as `POST` with headers `authorization`, `x-client-name`, `x-client-version`, `accept-language`. `authorization` carries the access token **without a `Bearer` prefix**. Whether `x-client-name`/`x-client-version` are required was not tested ❌.
- The site rejects list names with punctuation such as `-` and `(` client-side ("Tarkista kirjoitusasu"); a plain word was accepted. Server-side rules unknown 🟡.
- The list page has a **"Lisää kaikki ostoskoriin"** (add all to cart) button per list ✅. So **a shopping list is the hand-off to the cart**: the MCP writes a list, the user presses one button and checks out themselves.

Favourites: `userFavorites { items { ean product(storeId) } }`, `userFavoritesAddItem(ean)`, `userFavoritesRemoveItem(ean)`.

### Delivery and pickup

- `deliveryArea(id) { areaId name storeId price deliveryMethod homeDeliveryType isFastTrack alcoholSellingAllowed postalCodes deliverySlots(startDate, endDate, orderId, reservationId) { date deliveryTimes { slotId availability startDateTime endDateTime price isClosed … } } nextDeliverySlot fastTrackOpeningHours store {…} }`
- `deliverySlot(id, reservationId)`, `searchPickupDeliveryAreas(storeId, freetext, pageSize) { areas { areaId store } }`, `addressAutosuggest(countryCode, query, searchContext)`.
- Slot reservation mutations: `createDeliverySlotReservation(deliverySlotId) { reservationId expiresAt }`, `refreshDeliverySlotReservation`, `releaseDeliverySlotReservation`.
- Delivery area ids are UUIDs. The selected store and area are local browser state (`selectedStoreId`, `selectedAreaId`, `selectedBrand` `@client`), not stored server-side.
- The site's own picker ("Valitse toimitustapa", described by the owner 2026-10-08): type an address (a street address; a bare city such as "Helsinki" finds nothing), pick Nouto, Kotiinkuljetus or Pikatoimitus (only some stores; the site lists nearby ones), then a day in a calendar and a time, each time with its own fee. The query that lists areas for an address is loaded lazily by the picker and was not in the saved page load 🟡. Enum values (`DeliveryMethod`, slot `availability`, `AddressSearchContext`) have not been seen live yet; the server maps `PICKUP` and `HOME_DELIVERY`, availability containing FULL or AVAILABLE, and reports anything else as `unknown` 🟡.
- What the server uses (0.6.0): `searchPickupDeliveryAreas` for a store's pickup areas, then one aliased `deliveryArea` query for their details and `nextDeliverySlot`, and `deliveryArea(id) { … deliverySlots(startDate, endDate) }` for the calendar. Nothing is reserved; `validateCart` gets the chosen `deliveryDate`, `slotId` and `areaId`.

### Orders and payment (never automate without explicit confirmation)

- Read: `userOrders(domain: Domain, dataSources: [UserOrderDataSource!], limit) { id orderNumber createdAt storeName deliveryDate totalCost orderStatus isModifiable isCancelable … }` (order history), `order(id) { … cartItems { ean name itemCount price … } summary { … } }`.
- Write: `createOrder(order: OrderInput)`, `updateOrder(id, order)`, `cancelOrder(id)`, `createPayment(orderId, cardId, …) { redirectUrl }`, `authorizePayment(orderId)`, `saveUserPaymentCard`, `removeUserPaymentCard`, `renameUserPaymentCard`, `setDefaultUserPaymentCard`.
- An `Order` carries its own `accessToken`, which matches the `x-order-access-token` request header; guest orders are probably addressed with it 🟡.

### Other

`mainNavigation(storeId, platform: WEB, preview, userConsent)` and `pageContent(where: ContentInput!)` serve CMS content; `store.discountProduct(discountCode)`, `store.mandatoryProducts(…)`, `store.allowReplacement`, `store.pickingAutomationLevel`, `createProductWish(ean, storeId, freeText)`, `bonusWidgetToken`, `serviceSubscriptions` also exist.

### Persisted-query hashes of the site

[samples/site-persisted-hashes.json](samples/site-persisted-hashes.json) lists the 11 hashes the search page actually sent (e.g. `RemoteFilteredProducts` → `85a4eed2…0f91`). They are deploy-specific and not needed while free-form query text is accepted.

## 5b. Recommended auth and caller UX

Context: the MCP is called by external apps used by non-technical people, and should make a polished caller experience easy. This is a design recommendation, not something observed.

### Where the login comes from

- **Do not read tokens from the user's everyday Chrome profile.** It means opening another program's storage (profile lock, encryption, breaks on browser updates), it is the behaviour of credential-stealing malware and may be flagged as such, and it gives the server everything in that profile rather than one login.
- Instead the **server opens its own login window** (a dedicated browser profile owned by the server) for a **one-time login**. A real browser window also gets through the website's bot challenge normally, because a person is using it.
- After login the server keeps **only the refresh token**. Access tokens stay in memory.
- Storage: **Windows Credential Manager** when the caller runs as the same Windows user on the same PC; otherwise a **configurable token file** (user-only permissions, path in config).
- Feasibility gate (not yet verified): this depends on `authTokens(refreshToken)` being usable outside the browser. If it is not, fall back to keeping the dedicated profile and re-reading the access token from it; the caller-facing design below does not change.

### Tools

| Tool | Behaviour |
|---|---|
| `login_status` | Returns `logged_in`, `logged_out` or `expired`, plus the display name when logged in. Never opens a window. |
| `start_login` | The caller triggers it from a button. Opens the login window on the user's screen and resolves when login completes, is cancelled, or times out. **Never opened implicitly** during other calls. |

Catalogue tools (search, product, stores, opening hours, categories, `validateCart`) work without login.

### Stable error codes

Every failure returns a machine-readable code plus short user-facing messages in Finnish and English, so the caller can show them as-is.

| Code | When | fi | en |
|---|---|---|---|
| `login_required` | No stored login | Kirjaudu ensin S-kaupat-tilillesi. | Please log in to your S-kaupat account first. |
| `session_expired` | Refresh failed or was rejected | Istunto on vanhentunut. Kirjaudu uudelleen. | Your session has expired. Please log in again. |
| `store_not_selected` | A store-specific call without a store | Valitse ensin kauppa. | Please choose a store first. |
| `product_unavailable` | Product not found, not in the store's assortment, or not orderable | Tuotetta ei ole saatavilla tässä kaupassa. | This product is not available in this store. |

`product_unavailable` maps from `ProductNotFoundError`, `ProductNotInAssortmentError` and `ProductAvailabilityError`.

### Token refresh

- Refresh silently before expiry and once on an auth failure, then retry the call once.
- **One lock around refresh**, held across processes (the token store is shared): refresh tokens may rotate, and several caller apps may run at once. After taking the lock, re-read the stored token before refreshing, in case another process already did.
- If refresh fails, return `session_expired`; do not open a login window.

### List writes report what happened

A list write returns, per requested item, one of: **added** (with the product actually written: EAN, name, quantity), **substituted** (requested vs. written product), or **missing** (with an error code). Resolve EAN → `sokId` and `name` first (required by `ShoppingListItemInput`) and optionally run `validateCart` to flag unavailable items before writing. The result should also say which list was written and that the user finishes with "Lisää kaikki ostoskoriin" on the site.

### If exposed over HTTP

The server needs **its own access key**, separate from the S-kaupat login, checked on every request. Bind to localhost by default. The S-kaupat tokens never leave the server.

### Not offered as tools

Order creation, payment, cancelling orders and payment-card changes stay out of the MCP unless the owner decides otherwise.

## 6. Rate limits and terms

- **No rate-limit headers** (`x-ratelimit-*`, `retry-after`) on any API response ✅. About 25 requests at ~10 s spacing saw no throttling; the actual limit is unknown ❌.
- CloudFront edge caching applies to `GET` (section 1), so cache-friendly GETs are the polite default.
- The website host is actively bot-protected (Vercel challenge), which signals how S Group feels about automated traffic even though the API host is open.
- The API is undocumented and unofficial; S Group can change or close it without notice. Keep request rates human-like, cache store lists and category trees, and check S-kaupat terms of use before distributing.

## 7. Field reference (mapped from validator responses)

All ✅ unless marked.

```
Query
  store(id: ID!): Store
  product(id: ID!, storeId: ID!): Product
  searchStores(query: String, brand: StoreBrand, cursor: String): { totalCount, cursor, stores: [StoreInfo] }
  stores                                   🟡
  userProfile: UserProfile                 ❌ auth, not called

Store
  id, name, shortName, brand, slug, coOperative
  weeklyOpeningHours: [StoreWeeklyOpeningTime!] { weekNumber, openingTimes: [StoreDayOpeningTime!]! }
    StoreDayOpeningTime { date, day, mode, ranges { open close }, message: LocalizedText 🟡 }
  contactInfo: StoreContactInfo { email, phoneNumber: StorePhoneNumber { number, callChargeGroup, callCharge: LocalizableText } }
  services: [StoreService!] { code, name: LocalizableText }
  navigation: [NavigationItem!] { id, name, slug, children }
  products(...): ProductList { total, from, limit, searchProvider, structuredFacets 🟡, productListItems: [ProductListItem] { product } }

StoreInfo (search result)
  id, name, brand, slug, domains, availablePaymentMethods (null), services,
  location: StoreLocation { address: StoreAddress { street{default}, postcode, postcodeName{default} }, coordinates { lat lon } }

Product
  id, ean, name, slug, storeId, brandName, supplierName
  price, approxPrice, priceUnit, basicQuantityUnit, quantityMultiplier
  comparisonPrice, comparisonUnit, depositPrice
  pricing: ProductPricing { currentPrice, regularPrice, campaignPrice, campaignPriceValidUntil, lowest30DayPrice,
                            comparisonPrice, comparisonUnit, depositPrice, isApproximatePrice, salesUnit }
  description, ingredientStatement, packagingLabels[], countryName { fi }
  nutrients: [Nutrient!] { name, value, ri, kcal }
  allergens: [Allergen!] { allergenTypeCode, allergenTypeText, levelOfContainmentCode }
  measurement: ProductMeasurement { netWeight, grossWeight, pceApproxWeight }
  location: ProductLocation { aisle, shelf, module, floor }
  hierarchyPath[] { id, name, slug }          // leaf first
  availability: ProductAvailability { label, date }   🟡 always null so far
  productDetails { productImages { mainImage { urlTemplate } }, nutrients { … } 🟡, wineSweetness 🟡 }
  isAgeLimitedByAlcohol, frozen, isNewProduct, isForceSalesByCount, isGlobalFallback, consumerPackageSize
```

Observed units: `priceUnit`/`basicQuantityUnit` `KPL`, `pricing.salesUnit` `PCE`, `comparisonUnit` `LTR`. Other values (kg items, weighed goods) not sampled ❌.

Error shapes are in [samples/errors.json](samples/errors.json): `PERSISTED_QUERY_NOT_FOUND` comes back with HTTP 200; validation errors with HTTP 400 and `extensions.code: GRAPHQL_VALIDATION_FAILED`.

## 8. Implications for s-kaupat-mcp

1. **Catalogue needs only plain HTTP and our own GraphQL text.** Store search, store details, opening hours, category tree, search, category browse, product detail and batch-by-EAN are all verified and anonymous.
2. **No hash management needed today.** Keep a thin fallback plan (hash-only persisted queries scraped from the site) in case the endpoint is locked down.
3. **Basket hand-off uses shopping lists**, not the cart: the cart is browser-local state the API cannot reach, while shopping lists are server-side, verified writable, and the site turns a list into a cart with one button (section 5).
4. Auth and caller UX: see section 5b.
5. Still open:

| Open item | How to close |
|---|---|
| Whether `authTokens(refreshToken)` works outside the browser; whether refresh tokens rotate; where the site's login flow hands over tokens | Build the login-window prototype (section 5b) and observe |
| Whether `x-client-name` / `x-client-version` are required on authenticated calls | Try one authenticated read without them |
| `UpdateShoppingListItemInput`, `OrderInput` field names | Validator probing with an invalid input object (nothing executes) |
| What a limited/unavailable product looks like (`availability`, `labels`) | Find a product with an availability label and query it with a date |
| `Filters` input, other `SortKey` values | DevTools while using the search filters/sort menu |
| Closed-day `mode`, `message` shape in opening hours | Query a store around a public holiday |
| Operations on pages other than search (store pages, checkout) | Repeat the bundle scan on those pages |
| Rate limits | Unknown; stay conservative |
