# Building an app on s-kaupat-mcp

This guide is for apps that call the server on behalf of people who are not technical: a chat app, a shopping assistant, a voice helper. The server is built so the app never has to show a technical message or guess what went wrong.

The rules of thumb:

- Branch on `error.code` or `error.action`, never on message text.
- Show `userMessage.fi` or `userMessage.en` as-is; they are written for end users.
- Store and product names are in Finnish as S-kaupat gives them. Times and prices are raw values (local Finnish time, euros) for the app to format.
- The server never places an order or touches payment. The user finishes on the S-kaupat site.

## 1. First screen

Call `get_setup_status` when the app starts.

```json
{
  "schemaVersion": "0.3",
  "mode": "live",
  "store": null,
  "login": { "status": "logged_out", "displayName": null },
  "canSearch": false,
  "canUseLists": false,
  "nextStep": "choose_store"
}
```

| `nextStep` | Show |
|---|---|
| `choose_store` | The store picker (section 2) |
| `log_in` | A "Log in to S-kaupat" button (section 3). Searching already works, so the app can let the user browse first |
| `null` | Everything is ready |

`mode` is `demo` when the server runs on sample data (the extension's Demo mode). Show a small "demo" badge then, so nobody thinks the prices are real. `login.status` can be `unknown` if S-kaupat did not answer; treat it like logged in and let a list call tell you otherwise.

## 2. Store picker

1. Ask for a city, store name or postal code and call `search_stores` with it. Each store has `name`, `chainName`, `street`, `postalCode`, `city` and `openingHoursToday` ready to show, and `coordinates` for sorting by distance.
2. When the user taps a store, call `select_store` with its `id`. The choice survives restarts.
3. `get_selected_store` shows the store again later, with the week's opening hours.

Opening hours `status` is `open` (with `ranges` in local time), `open_24h`, `closed` or `unknown`.

## 3. Login

Shopping lists need the user's S-kaupat account; searching does not.

1. Show the state from `get_setup_status` or `login_status`: "Logged in as Ville" or a "Log in" button.
2. When the user presses the button, call `start_login`. A small S-kaupat window opens on the user's screen; they log in as they normally would and the window closes itself.
3. The call returns when they finish (`logged_in`), close the window (`cancelled`) or wait too long (`timed_out`), each with a `userMessage` to show.

Call `start_login` only after the user asks for it. If the app is an AI assistant, the model should ask "Shall I open the S-kaupat login?" first. While the window is open, other calls answer `login_in_progress`; show "Finish logging in in the S-kaupat window".

When S-kaupat ends the login, calls answer `session_expired` and the app shows the "Log in" button again.

## 4. Finding products

- `search_products` with Finnish search words works best (`maito`, `ruisleipä`, `kahvi`). Use `sort: "price_asc"` for "cheapest", and `offset` for "show more".
- `list_categories` and `browse_category` give a category menu.
- `get_product_details` gives ingredients, allergens and nutrition for one product.
- `get_products` refreshes prices for products the app already has, in one call.

Prices are for the chosen store. `price` is what the user pays now; `regularPrice` and `campaignValidUntil` let the app show "on offer until Sunday". Fields S-kaupat did not report are `null`, never guessed.

## 5. Filling a shopping list

Call `create_shopping_list` with a name and products, or `add_to_shopping_list` with a list id. Each product is `{ productId, quantity, allowSubstitutes }`; `quantity` is pieces, or kilograms for products sold by weight.

The result has one entry per product. Show it as a short checklist:

| `status` | Show |
|---|---|
| `added`, `updated`, `unchanged` | ✓ on the list. If there is a `warning`, add its `label` or `userMessage` (for example "Tilapäisesti loppu", temporarily out of stock) |
| `missing` | ✗ not added, with `error.userMessage`. `error.reason` says why: `not_sold_in_store`, `unknown_barcode`, `no_internal_id` or `write_failed` |
| `uncertain` | ? S-kaupat did not confirm. Suggest checking the list (`get_shopping_list`) |

`summary` has the counts for a one-line answer ("5 products added, 1 not available in this store"). `list.estimatedTotal` is the total at shelf prices; when `complete` is `false`, say "about".

Then show `nextStep` in the user's language: the user opens the list on the S-kaupat site or app, presses **Lisää kaikki ostoskoriin** (add all to cart) and checks out there. The site keeps its own store choice, so it asks the user to pick the store and pickup or home delivery before the products go to the cart; `nextStep` says so and names the store chosen here, or the exact pickup time when one was chosen (section 5b).

## 5b. Choosing a pickup time

Optional, but it saves the user a step on the site and lets the app check the basket for the right day. The site calls this **Valitse toimitustapa**. Walk it as one screen per step, and keep a "Back" on each:

1. **Where and how.** Two ways in, like the site:
   - **From an address** (what the site does). A search box calls `find_address` as the user types (a street with the city, e.g. "Mannerheimintie 1, Helsinki"; a city alone finds nothing, and `hint` says so). Show each match's `title`; street addresses (`kind` `houseNumber` or `street`) come first, then pickup places S-kaupat suggests whatever was typed (`kind: "place"`). Pass the picked match's `location` to `get_delivery_options`. The answer has:
     - `methods`: pickup, home delivery and express, each with `available` and S-kaupat's own Finnish `summary` ("8,90–14,90 € • Huomenna"). Show them as three buttons and disable the unavailable ones.
     - `pickupOptions`: the pickup places nearest to the address, with `distanceMeters`, `address` and `nextSlot`, nearest first.
     - `homeDeliveryOptions`: the stores that deliver to that postal code, each with `nextSlot` and `freeTimesOnDate`.
     - `expressStores`: stores that deliver within about an hour (`kind` `one_hour` or `robot`, `summary`, `fee`). Pikatoimitus is ordered on the site for now (`siteOnlyMethods`): tell the user to choose it there after "Lisää kaikki ostoskoriin" and go straight to `open_site`.
     - `partial`, only when a part could not be read; show the rest.

     The address is the user's personal data: the server does not save or log it; keep it in the app only if the user wants that.
   - **From the chosen store.** `get_delivery_options` without `location` lists the store's own pickup places.

   Show each pickup or home delivery option as a card: `name`, `address` (pickup), "next free: …" from `nextSlot` (from the store's list its `end` and `closesAt` may be null; the calendar has both). `expressTimesOnDate` counts "Pikanouto"/fast-track times, which are chosen on the site.
2. **Day.** `get_delivery_slots` with the option's `areaId` returns `days`, each with `availableCount`. Show a week as a row of days and grey out days with `availableCount: 0`. Ask for the next week with `fromDate`.
3. **Time.** The chosen day's `slots`, each with `start`–`end` and its own fee. Only `available` can be chosen; show `full` and `closed` greyed out, and treat `unknown` like `full`. Times are ISO; show them in Finnish local time.
4. **Summary.** `select_delivery` with `areaId` and `slotId`. If someone took the time meanwhile it fails with `slot_unavailable` (action `choose_delivery_time`): show the times again. On success show `delivery` as a confirmation: place, day, time and fee.

Times fill up and prices change, so read the calendar fresh each time the screen opens and don't keep it in the app. The choice is remembered like the store, and `get_setup_status` returns it as `delivery`. When the time has passed, `delivery.status` is `expired` and `nextStep` is `choose_delivery`: show step 1 again with a short note.

The time is **not reserved** on S-kaupat. The site keeps its own choice in the browser, so after "Lisää kaikki ostoskoriin" the user picks the same place and time on the site. `delivery.siteInstruction` (also in a list's `nextStep`) says exactly what to tap, in Finnish and English, for example:

> Valitse sivulla "Valitse toimitustapa": Nouto, Prisma Herttoniemi, pe 9.10. klo 16:00–18:00.

**Finish in the server's own window.** A "Go to checkout" button can call `open_site`: it opens S-kaupat in the server's own browser window, where the user is already logged in, so they don't need to log in again in their own browser. Show the returned `nextStep` next to the button. A pickup time chosen with `select_delivery` is filled in on the site before the window opens (`prefilled: true`; a home delivery time is not, because the site then needs the delivery address: `nextStep` says what to pick), so the user only checks it there; `nextStep` then says so. `get_site_choice` tells whether the site still has the chosen time (`matchesSelection`). Pass `applyChoice: false` to open the site as it is. In demo mode both answer `unsupported`.

**Check the basket for that day.** `check_basket` with a `listId` (or `items`) asks S-kaupat whether each product can be ordered for the chosen time. Show problems next to the product, using `label` (S-kaupat's own words, e.g. "Tilapäisesti loppu") when there is one. `checkedFor` is `null` when no time is chosen; then the check is for the store in general.

## 5c. Checkout in the app

The whole order can happen in the app's own screens. The only step outside it is card payment: S-kaupat sends every card payment, saved cards included, to its payment provider's page. Pay on delivery, where the store offers it, needs no page at all.

1. **Checkout screen.** After a time is chosen (5b), `get_checkout_options` gives everything for one screen:
   - `paymentMethods`: the methods this user can use here: `card`, `on_delivery`, and `invoice` for company customers only. Show them as radio buttons.
   - `savedCards`: the account's cards (`label`, `maskedNumber`, `expiryStatus`; `expired` ones can't be used, so grey them out) and which one is the default. "New card" is always an option.
   - `packagingOptions` with prices, and `defaultPackagingId` (the site's own default). Most apps can show the default with a "Change" link.
   - `contact`: the name, phone and e-mail on the S-kaupat account, to pre-fill. Let the user change them.
   - `needsAddress`: true for home delivery. Use the address the user picked in `find_address` (`street`, `postalCode`, `city`, coordinates), and ask for the staircase and flat (`extra`).
   - `smallOrderFee` ("orders under 40,00 € cost 5,90 € more") and `mandatoryProducts` (fees S-kaupat adds for this time).
2. **Summary.** `review_order` with the products (`listId` or `items`), `payment`, and any changed `contact`, `address`, `packagingId` or `note`. Nothing is reserved or ordered. Show:
   - `items` with `status` per product for the chosen time (`ok`, `unavailable` with S-kaupat's `label`, `not_in_store`, ...),
   - `delivery` (place, day, time), `payment` and `contact`,
   - `summary`: S-kaupat's own rows (`products`, `smallOrderFee`, `serviceFees`, `discounts`, `total`, each with its Finnish `title` and formatted `amount`) and `disclaimer` (weighed products are charged by real weight). Show them as they are. When `summarySource` is `estimate`, S-kaupat's own summary was not available; say "about".
   - If `ready` is false, `missing` lists the fields to ask for (for example `contact.phone`, `address`) and `problems` what to change (`payment_method_not_offered`, `card_expired`, `ordering_not_possible`, `products_not_sold_here`). Fix them and call `review_order` again.
3. **Order button.** Only after the user presses it, call `place_order` with exactly the same inputs and `confirmationCode` from the review. If anything changed meanwhile (the cart, the time, the total), it fails with `confirmation_required` (action `review_order`): show the new summary. The code is valid for 15 minutes and works once.
   `place_order` reserves the time, checks the products once more and creates the order on the user's S-kaupat account. The answer has `order` (`orderNumber`, `state`, `payment`) and `nextStep` in Finnish and English.
4. **Payment.** For `card`, `payment.url` is the payment provider's page:
   - `paymentPage: "own_window"` (default) opens it in the server's own browser window, already logged in. When the user has paid, the provider returns to S-kaupat's own page in that window, which completes the payment.
   - `paymentPage: "app"` only returns the URL, for the app's own web view. When the web view reaches `payment.returnUrlPrefix` (`https://www.s-kaupat.fi/payment/auth/<orderId>?responseCode=OK&...`), close it and call `confirm_payment`. `responseCode=Cancel` means the user cancelled.
   - `paymentPage: "later"` creates the order without starting a payment; `pay_order` starts it.
   Then call `get_order` (for example every few seconds while the payment screen is up, and when the app comes back to front): `payment` turns `paid` when done. On `payment_failed` offer `pay_order` again (another card) or `cancel_order`. An unpaid card order is not picked: S-kaupat cancels it if it stays unpaid.
5. **After.** `get_order` with no `orderId` lists the orders placed through the app; with an `orderId` it gives the state (`received`, `being_picked`, `done`, `cancelled`), payment, S-kaupat's summary and `isCancelable`. `cancel_order` cancels while S-kaupat allows it; ask the user to confirm first.

Rules that keep the user safe:
- Never call `place_order` without the user pressing an order button after seeing the summary.
- After `order_uncertain` (the answer was lost, so the order may or may not exist), never place again: call `get_order` and look at the user's orders first.
- `unpaid_orders` means S-kaupat refuses new orders while an earlier one is unpaid; `unpaidOrders` lists them with a payment link.
- An app that does not want ordering at all sets `ordering: false` (or `SKAUPAT_ORDERING=false`); `place_order` then answers `orders_disabled`.
- The order's own access token is kept in the server's data folder (`orders.json`, readable by the user only) and is never returned or logged.

## 6. Errors

Every failure looks like this:

```json
{
  "schemaVersion": "0.3",
  "error": {
    "code": "session_expired",
    "action": "log_in",
    "retryable": false,
    "message": "technical detail for logs",
    "userMessage": { "fi": "Istunto on vanhentunut. Kirjaudu uudelleen.", "en": "Your session has expired. Please log in again." }
  }
}
```

Show `userMessage`, then offer what `action` says:

| `action` | Offer |
|---|---|
| `log_in` | The "Log in" button (`start_login`) |
| `finish_login` | "Finish logging in in the S-kaupat window", then try again |
| `choose_store` | The store picker |
| `choose_delivery` | The pickup options again (step 1 of 5b) |
| `choose_delivery_time` | The times again (step 2 of 5b) |
| `retry` | A "Try again" button. Retry automatically at most once, after a few seconds |
| `check_list` | Show the list again so the user sees what is on it |
| `refresh_lists` | The list was deleted (perhaps on the site); show the lists again |
| `choose_other_product` | Suggest another product (search again) |
| `install_browser` | "S-kaupat needs Microsoft Edge or Google Chrome on this computer" |
| `review_order` | Show the order summary again (`review_order`) and let the user confirm or fill in what is missing |
| `pay` | The payment step again (`pay_order`), or another payment method |
| `check_orders` | Show the user's orders (`get_order`) before doing anything else |
| `none` | Nothing the user can fix; log `message` for the developer |

`retryable` is `true` when trying again later can help without the user doing anything.

## 7. What the user sees on their computer

In live mode the server sends S-kaupat calls from its own Edge or Chrome window, started minimised in the taskbar, because S-kaupat only answers its own website. The window closes itself after 3 minutes without calls. If the user asks about it, the app can say it is the S-kaupat connection and can be ignored or closed. Both this window and the login window show that software controls them; that is intended.

## 8. Try it without an account

Run with Demo mode on (`SKAUPAT_DEMO=true`): sample stores and products, `start_login` succeeds at once as "Testi", lists live in memory, and product `0000000000055` is out of stock, so every screen above can be built and tested offline.
