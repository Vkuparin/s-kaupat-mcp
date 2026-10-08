# Changelog

The server follows [semantic versioning](https://semver.org/) from 1.0.0. What counts as a breaking change is in [docs/embedding.md](docs/embedding.md#versions).

## 1.1.0

- `login_status`, `start_login` and `get_setup_status` give `accountId` when logged in: a stable ID for the S-kaupat account, the same on any device and across logins, so apps can keep their own data per account and notice an account switch. It is a one-way hash of S-kaupat's user ID, which is never returned.

## 1.0.0

The first stable release: tool names, inputs, result fields and error codes stay compatible across 1.x (see [docs/embedding.md](docs/embedding.md#versions)). Same code as 1.0.0-rc.1, after it was checked on a real Windows PC: the extension, the live site (search, stores, lists, delivery choice, order review, order history) and the standalone exe. The known limits below still apply.

## 1.0.0-rc.1

First release candidate for 1.0.0. Nothing in the tools changed shape since 0.12.2; this release fixes the contract.

- `schemaVersion` is now `1.0` and stays `1.0` for all of 1.x.
- Licensed under Apache-2.0, so any app may bundle and ship the server.
- The server's minimised S-kaupat window no longer shows a taskbar button or an Alt+Tab entry on Windows. The login window and pages opened for the user still do.
- `get_order_items` leaves out fee rows such as the delivery fee, like the site's own "order again" (seen live: fees without a product came back as items).
- The release workflow marks tags with a suffix (like `v1.0.0-rc.1`) as pre-releases and takes the release notes from this file.

Known limits:

- **A real card payment has not been tried end to end.** Placing an order, choosing a saved card and opening the payment page are built and tested in demo mode. One test order was placed on the live site and cancelled before payment. Paying with a card on the provider's page has not been run live.
- The Windows exe is not code-signed, so SmartScreen warns on first start from a download. Apps should ship it inside their own signed installer.
- The server needs a signed-in Windows desktop session (a visible login window and a minimised browser window), so it can't run as a Windows service.

## 0.12.2

- Ordering works when an app uses local HTTP mode or opens one MCP server per connection. Before, `place_order` always asked to review again because the confirmation code was kept per server.

## 0.12.1

- An order call that times out or fails partway is reported as `order_uncertain`; the app checks `get_orders` before trying again, so no order is placed twice.
- `log_out` really forgets the session, also when two apps share it.
- Shopping-list changes leave exactly one row per product, and bad quantities get a reason (`whole_pieces_only`, `too_many`).
- Delivery dates more than 4 weeks ahead are refused with a clear error.
- Demo mode keeps its settings and orders apart from the real ones.

## 0.12.0

- `log_out` to log out or switch account.
- `get_order_items` gives a past order's products, ready for `review_order` (order again).
- `get_order` shows the pickup-locker PIN.
- Releases include `tools.json` (every tool's schema) and `SHA256SUMS`.

## 0.11.0

- `get_orders` lists the account's orders, also those placed on the S-kaupat site, grouped as needing payment, active and past.

## 0.10.0

- Pikatoimitus (express) pickup and delivery can be chosen and ordered in the app.

## 0.9.0

- Checkout in the app: `get_checkout_options`, `review_order` with S-kaupat's own price summary, `place_order` after the user's explicit yes, card payment on the provider's page, `get_order`, `pay_order`, `confirm_payment` and `cancel_order`. Ordering can be turned off with one setting.

## 0.8.0

- Home-delivery times and Pikatoimitus stores in the app.

## 0.7.0

- Address search, the delivery methods offered at an address, and the nearest pickup places.

## 0.6.0

- Pickup options and times, choosing and clearing a time, and a basket check against the chosen time.

## 0.5.0

- Packaged for any app: a standalone Windows exe, a single-file JavaScript bundle, an npm library (`createRuntime`, `startHttpServer`), a settings file and a local HTTP mode with an access key.

## 0.4.0 and earlier

- Store search and choice, product search and details, categories, login in the server's own window, shopping lists, a caller-app guide with stable error codes and Finnish and English user messages, and the Claude Desktop extension.
