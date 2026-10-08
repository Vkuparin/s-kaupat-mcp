# Interactive tests left for a real PC

Everything below needs a Windows PC with Edge, a real S-kaupat account and the network to reach s-kaupat.fi, so it could not run in CI. The automated tests (`npm test`) cover the same flows against recorded responses and fakes.

Start from a fresh build: `npm ci && npm run build && npm run pack:extension`.

## 1. Extension install
- [x] Install `s-kaupat-0.4.1.mcpb`: Claude Desktop → Settings → Extensions, drag the file in (or Advanced settings → Install Extension…). Claude Desktop shows the install dialog with the Demo mode switch. (2026-10-08: double-clicking the file showed nothing on Ville's PC; installing from Settings worked.)
- [ ] With Demo mode on, "find milk" works with no browser window and no login.
- [ ] Turn Demo mode off and restart Claude Desktop.

## 2. Browser window (API transport)
- [ ] The first S-kaupat call opens one Edge window **minimised in the taskbar**, not in front.
- [ ] The window shows the "controlled by automated software" bar. This is intended: it does not hide that software drives it.
- [ ] S-kaupat answers calls from it (no `blocked`). If it answers `blocked`, note whether the site shows a check in the window.
- [ ] The window closes after about 3 minutes without calls, and the next call opens it again.
- [ ] Closing the window by hand: the next call still works.

## 3. First run
- [ ] Before choosing a store, `get_setup_status` says `nextStep: choose_store`; after choosing, `log_in`; after logging in, `null`.

## 4. Store
- [ ] "Find S-markets in Tampere" lists stores; picking one saves it; `get_selected_store` shows it after a restart.

## 5. Login
- [ ] `start_login` opens a normal-sized login window (with the automation bar); logging in closes it and returns your first name.
- [ ] While it is open, a product search answers `login_in_progress`.
- [ ] `login_status` says logged_in after a Claude Desktop restart.
- [ ] Token renewal outside the browser: after an hour or more idle, a list call still works without a login window.
- [ ] Log out on the site in the server's window (or wait for expiry): the next list call answers `session_expired`, and `start_login` opens the window and does not reuse the old login.

## 6. Products
- [ ] Search "maito", sorted by price; page two with offset.
- [ ] Product details for a product with allergens and nutrients.
- [ ] Categories: top level, then browse one category.

## 7. Shopping list round trip
- [ ] Create a list with 3 products, one of them a quantity of 2. Every result says `added`.
- [ ] Add the same product again with a new quantity: `updated`, and the list on the site shows one row with the new quantity (not two rows). Note what the site does if it shows two.
- [ ] Remove one product; delete the list.
- [ ] On s-kaupat.fi, "Lisää kaikki ostoskoriin" puts a list's products in the cart.

## 8. Two apps at once
- [ ] With two apps running the server, the second one gets `browser_busy` while the first one's window is open, and works after it closes.
