# The host page transport

Since 1.3.0. For an app that keeps an S-kaupat page signed in itself, such as a view inside its own window. The server then runs no browser: its calls go out from the app's page, and the login is the one the user made on the site in that page.

```text
set SKAUPAT_HOST_KEY=<at least 24 random characters your app generates>
s-kaupat-mcp.exe --transport host --host-url http://127.0.0.1:8730/s-kaupat --data-dir "%LOCALAPPDATA%\MyApp\s-kaupat"
```

The server only talks to this address, and the address must be `http://127.0.0.1`, `http://localhost` or `http://[::1]` with a port, because the key and the user's login never leave the PC. The key is read from the environment or the config file (`hostKey`), never from a flag.

## What the app provides

A local endpoint. The server sends `POST <hostUrl>/<operation>` with `Content-Type: application/json` and `Authorization: Bearer <key>`. Answer `401` to a wrong key. Every answer is JSON. The page is the app's own page on `https://www.s-kaupat.fi/` (the origin the site's own code runs on).

| Operation | Request body | Answer | What the app does |
|---|---|---|---|
| `fetch` | `{ url, method, headers, body, timeoutMs }` | `{ ok: true, status, contentType, body }` or `{ ok: false, error }` | Runs `fetch(url, { method, headers, body })` in the page and returns the response status, its `content-type` and its text. `error` is `"timed out"`, `"offline"` (the browser has no network) or the error text. Refuse a `url` that is not `https://api.s-kaupat.fi/` or on `https://www.s-kaupat.fi/` |
| `storage` | `{}` | `{ ok: true, entries: [[key, value], ...], path }` | The page's `localStorage` as key/value string pairs, and the path the page is on (or `null`) |
| `reload` | `{}` | `{ ok: true }` | Reloads the page. The site renews its own login when it loads |
| `open` | `{ url }` | `{ ok: true }` | Shows this S-kaupat URL to the user (the app's own view). Refuse other hosts |
| `forget` | `{}` | `{ ok: true }` | Clears the site's storage and the sign-in cookies in the page's session, so the next sign-in asks for the account |

Nothing else is ever asked: the server never sends script to run. An error answer for `storage`, `reload`, `open` or `forget` is `{ ok: false, error }`; the server reports the store as unavailable.

## How the login works

The site keeps its login in `localStorage`, key `session-storage`, at `state.authTokens`: `accessToken`, `idToken` and `refreshToken` (seen live on 9 October 2026; the access token lasts about two weeks). The server finds an object with a `refreshToken` anywhere in the storage values, like the login window of the browser transport, so it does not depend on the exact key.

- It sends the `accessToken` as the `authorization` header of its calls, as the site does (the raw token, no `Bearer`).
- It never uses the refresh token. S-kaupat may rotate the refresh token each time it is used, and that would sign the app's page out.
- When the access token is missing, about to expire (less than a minute left) or rejected, the server calls `reload` and waits up to 15 seconds for the site to write a new one into the storage. If it does not, the login is reported as `expired` and the user signs in again in the app.
- `start_login` calls `open` with the front page and waits until the storage holds a login. The app can also let the user sign in on its own and never call it; `login_status` then reports `logged_in` as soon as the storage holds one.
- `log_out` calls `forget` and clears what the server remembers about the account.
- The server keeps no login on disk in this transport: nothing is written to Credential Manager or a token file.

`accountId` and `displayName` come from the same call the browser transport uses, so they are the same for the same account in either transport.

## What does not work

- `open_site` shows the page with `open` but does not fill in the pickup time: the page belongs to the app, and the server does not write to its storage.
- Calls are sent one at a time at least 500 ms apart, as with the browser transport. If S-kaupat refuses a call (403 or 429), the server reloads the page once and retries once.
- The app's page must be loaded for calls to work. If the app has no page loaded, `fetch` should load the front page first.
