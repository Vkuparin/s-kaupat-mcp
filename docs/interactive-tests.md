# Interactive tests left for a real PC

What is left here needs Ville's own hands: his S-kaupat account, his eyes on a window, or Claude Desktop. Everything that could run without them was checked on his PC on 2026-10-08, anonymously, by a local session (see "Already checked" at the end). The automated tests (`npm test`) cover the same flows against recorded responses and fakes.

Install the newest `s-kaupat-<version>.mcpb`: Claude Desktop → Settings → Extensions, drag the file in (double-clicking it does nothing on Ville's PC).

## 1. Claude Desktop
- [ ] With Demo mode on, "find milk" works with no browser window and no login.
- [ ] Demo mode off, restart Claude Desktop: `get_selected_store` and `login_status` still know the store and the login.

## 2. The minimised window
- [ ] The first call opens one Edge window minimised in the taskbar, with one tab and the "controlled by automated software" bar (intended).
- [ ] It closes after about 3 idle minutes; the next call opens it again. Closing it by hand: the next call still works.

## 3. Login
- [ ] After an hour or more idle, a list call still works without a login window (token renewal).
- [ ] While the login window is open, a product search answers `login_in_progress`.
- [ ] Log out on the site in the server's window: the next list call answers `session_expired`, and `start_login` does not reuse the old login.

## 4. Choosing a pickup time and finishing on the site
- [ ] Ask Claude for pickup options near your home address: `find_address` finds it and `get_delivery_options` shows Nouto, Kotiinkuljetus and Pikatoimitus with the site's own price summaries, and the nearest pickup places.
- [ ] Pick a time, then "go to checkout": `open_site` opens S-kaupat logged in, and its header shows the same place and time (for example "Nouto: Prisma Herttoniemi noutolokero pe 9.10. 09.00–10.00"). The storage side of this was confirmed; the header was hidden by the cookie dialog of a fresh profile.
- [ ] On your list there, "Lisää kaikki ostoskoriin" puts the products in the cart for that time. Don't check out.

## 5. Shopping list on the site
- [ ] A list made by Claude shows the same rows on the site; removing a product and deleting the list from Claude show on the site too.

## Already checked (2026-10-08, Ville's PC)
- Install from Settings, store search and choice, login picked up from the server's window, product search, list create and update, minimised window.
- Pickup places and times of Prisma Herttoniemi match the site (same slot ids and prices); choosing a time; `open_site` writes it into the site's storage and `get_site_choice` reads it back (`matchesSelection: true`).
- Two servers on one data folder: the second gets `browser_busy` (0.6.2).
- Standalone exe: builds, `--version` prints the version, `--demo` answers over stdio (about 110 MB).
