# Interactive tests left for a real PC

Everything below needs a Windows PC with Edge, a real S-kaupat account and the network to reach s-kaupat.fi, so it could not run in CI. The automated tests (`npm test`) cover the same flows against recorded responses and fakes.

Start from a fresh build: `npm ci && npm run build && npm run pack:extension`.

## 1. Extension install
- [x] Install `s-kaupat-0.5.1.mcpb`: Claude Desktop → Settings → Extensions, drag the file in (or Advanced settings → Install Extension…). Claude Desktop shows the install dialog with the Demo mode switch. (2026-10-08: double-clicking the file showed nothing on Ville's PC; installing from Settings worked.)
- [ ] With Demo mode on, "find milk" works with no browser window and no login.
- [ ] Turn Demo mode off and restart Claude Desktop.

## 2. Browser window (API transport)
- [x] The first S-kaupat call opens one Edge window **minimised in the taskbar**, not in front. (0.4.2 on 2026-10-08: minimised, but a leftover about:blank tab; 0.4.3 closes tabs that open late. Recheck one tab.)
- [ ] The window shows the "controlled by automated software" bar. This is intended: it does not hide that software drives it.
- [x] S-kaupat answers calls from it (no `blocked`). (2026-10-08: store search, product search and list writes all worked.) If it answers `blocked`, note whether the site shows a check in the window.
- [ ] The window closes after about 3 minutes without calls, and the next call opens it again.
- [ ] Closing the window by hand: the next call still works.

## 3. First run
- [x] Before choosing a store, `get_setup_status` says `nextStep: choose_store`. (2026-10-08; the later steps not yet rechecked.)

## 4. Store
- [x] "Find S-markets in Tampere" lists stores; picking one saves it (2026-10-08: Prisma Herttoniemi). Still to check: `get_selected_store` after a restart.

## 5. Login
- [x] `start_login` returns your first name. (2026-10-08: a stale saved login read as `expired`; Ville had signed in on the site in the server's window, and `start_login` picked that up without a password.)
- [ ] While it is open, a product search answers `login_in_progress`.
- [ ] `login_status` says logged_in after a Claude Desktop restart.
- [ ] Token renewal outside the browser: after an hour or more idle, a list call still works without a login window.
- [ ] Log out on the site in the server's window (or wait for expiry): the next list call answers `session_expired`, and `start_login` opens the window and does not reuse the old login.

## 6. Products
- [x] Search "maito", sorted by price. (2026-10-08: S-kaupat's own price sort ranked yeast and margarine first; 0.4.2 sorts only the 50 most relevant matches. Recheck.)
- [ ] Product details for a product with allergens and nutrients.
- [ ] Categories: top level, then browse one category.

## 7. Shopping list round trip
- [x] Create a list with products: every result says `added` (2026-10-08, 2 products).
- [x] Add the same product again with a new quantity: `updated`, one row with the new quantity (2026-10-08, list Testi). Still to check: the site shows the same.
- [ ] Remove one product; delete the list. (2026-10-08: Ville deleted the test list on the site; reading it then answered `upstream_error` instead of `list_not_found`, fixed in 0.5.1.)
- [ ] On s-kaupat.fi, "Lisää kaikki ostoskoriin" puts a list's products in the cart. (2026-10-08: the list showed correctly on the site; the button first asked for a store/delivery location. 0.4.2 says so in `nextStep`. Recheck that the products land in the cart after picking it.)

## 8. Two apps at once
- [ ] With two apps running the server, the second one gets `browser_busy` while the first one's window is open, and works after it closes.

## 9. Standalone executable (for apps)
- [ ] Download `s-kaupat-mcp.exe` from the Release workflow's artifact. `s-kaupat-mcp.exe --version` prints the version, without Node installed.
- [ ] Run it with `--data-dir` pointing at a new folder from an MCP client (for example `npx @modelcontextprotocol/inspector s-kaupat-mcp.exe --data-dir C:\temp\skaupat`): a store search opens the minimised window and answers; `start_login` opens the login window.
