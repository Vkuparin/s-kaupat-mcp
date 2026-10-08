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

Then show `nextStep` in the user's language: the user opens the list on the S-kaupat site or app, presses **Lisää kaikki ostoskoriin** (add all to cart) and checks out there. The site keeps its own store choice, so the first time it asks the user to pick the store and pickup or home delivery before the products go to the cart; `nextStep` says so and names the store chosen here.

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
| `retry` | A "Try again" button. Retry automatically at most once, after a few seconds |
| `check_list` | Show the list again so the user sees what is on it |
| `refresh_lists` | The list was deleted (perhaps on the site); show the lists again |
| `choose_other_product` | Suggest another product (search again) |
| `install_browser` | "S-kaupat needs Microsoft Edge or Google Chrome on this computer" |
| `none` | Nothing the user can fix; log `message` for the developer |

`retryable` is `true` when trying again later can help without the user doing anything.

## 7. What the user sees on their computer

In live mode the server sends S-kaupat calls from its own Edge or Chrome window, started minimised in the taskbar, because S-kaupat only answers its own website. The window closes itself after 3 minutes without calls. If the user asks about it, the app can say it is the S-kaupat connection and can be ignored or closed. Both this window and the login window show that software controls them; that is intended.

## 8. Try it without an account

Run with Demo mode on (`SKAUPAT_DEMO=true`): sample stores and products, `start_login` succeeds at once as "Testi", lists live in memory, and product `0000000000055` is out of stock, so every screen above can be built and tested offline.
