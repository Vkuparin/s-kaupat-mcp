# s-kaupat-mcp prerequisite project

Decision recorded 8 October 2026: build this as a separate repository and release it before Korikone's real store integration. This file defines the handoff; it does not create or implement that repository.

## Ownership and scope

The project owns S-kaupat discovery, login, session storage, catalogue access, cart operations, protocol schemas, fixtures and release artifacts. Korikone owns meal planning, product preferences, budgets, approvals and its user interface. No dependency from s-kaupat-mcp back to Korikone.

Recommended starting implementation: TypeScript with a reusable client and a thin MCP SDK wrapper. S0 chooses between a managed browser session and a minimal extension; Playwright is a candidate for the managed-session implementation, not a settled requirement. Prove distributable packaging early; language choice is less important than a stable protocol and no developer tools on the user's machine. Inspect mcp-ruoka for catalogue behavior, subject to reuse permission; independently establish cart behavior.

## Minimum usable release

| Tool | Contract |
|---|---|
| `search_stores` | Query or location to stable branch IDs and supported fulfillment modes. |
| `search_products` | Explicit branch/context, query and limit; return IDs, pack size, quantity units, price basis, availability and observation time. Unknown fields remain unknown. |
| `get_products` | Refresh exact product IDs in the selected context or return explicit unavailable/unknown results. |
| `auth_status` | Distinguish signed out, signed in, expired, blocked and uncertain; provide an opaque account identity for verification. |
| `start_login`, `login_status`, `cancel_login` | Human login in a visible browser; structured lifecycle suitable for an app UI. No passwords through MCP. |
| `get_cart` | Return verified account/context, current lines, product IDs, cart line IDs, quantities, units and totals when known. Never treat an anonymous basket as an authenticated one. |
| `set_cart_item_quantity` | Set an absolute target, preserving native quantity units and increments. Return a write result backed by readback or explicitly uncertain. |
| `remove_cart_item` | Remove one known line and verify absence. |
| `open_cart` | Hand the same authenticated cart to a human-controlled browser window; automation detaches before checkout. |

Tool names above are proposed, not existing upstream APIs. Publish JSON schemas, capabilities, schema version and examples with the release. Tool errors need stable codes such as `auth_required`, `session_expired`, `blocked`, `invalid_quantity`, `context_changed`, `unavailable`, `conflict`, `unsupported` and `write_uncertain`.

No bulk clear, order placement or payment tools. A standalone server still validates arguments, scopes sessions and serializes writes; Korikone's approval system is not a substitute for safe server behavior.

## Build sequence

### S0. Feasibility and reuse rights

Inspect the normal S-kaupat browser flow. Compare two narrow working prototypes with an owned test account and a deliberately small basket: (A) a dedicated managed browser session, and (B) a minimal extension in the user's normal browser session. Establish login, branch/slot context, authenticated cart identity, exact quantity updates, removal and same-cart browser handoff for each viable approach. Use supported access where available; stop if access is denied. Record sanitized request/response fixtures and uncertainties. Check the licenses of any code intended for reuse.

Record these results for each prototype:

| Scenario | Evidence to record |
|---|---|
| Clean-machine installation | Components/downloads, permissions, user steps and any developer intervention |
| First and returning login | Required logins, session persistence, account/profile ambiguity |
| Cart operations | Correct branch, native units, absolute quantities and readback |
| Browser close/restart and expired login | Preserved work, reconnect behavior and user interventions |
| Interrupted write | Detection of success versus uncertainty; no blind replay |
| Manual checkout handoff | Same authenticated cart, usable browser and automation fully detached |

Choose the approach with fewer user interventions and more reliable recovery. One installer is the target; an extension needs a demonstrated benefit that justifies its setup. Record limitations and the combined K-Ruoka/S-kaupat onboarding implications. Do not build a side panel or keep two production transports during the experiment. Neither approach is assumed to work until observed.

If the extension wins, the standalone project owns its minimal bridge, native helper, versioned message schemas and installation instructions. A generic MCP client must still work without Korikone. Specify how the browser-launched native host connects to the MCP process, how each process starts/stops, and how reconnects avoid duplicate commands. Do not treat Native Messaging framing and MCP stdio as interchangeable. Allowlist the extension and retailer origins, validate senders and fixed command schemas, bind requests to the selected account/tab/context, and reject arbitrary JavaScript or URLs. Do not export browser cookies. Store no AI credentials in the extension. Browser API/session access remains a feasibility test.

Exit: a documented browser-approach decision and a written capability matrix with observed results. Catalogue-only success does not pass the cart gate. If cart access fails, publish that limitation and keep Korikone's S-kaupat experience in explicit shopping-list preview mode.

### S1. Client and hermetic tests

Implement the retailer client and selected browser approach, verified session/account binding, one writer per account/cart, pacing, cancellation, session recovery, quantity handling and verified mutations. Build tests around anonymous carts, expired login, missing products, weight units, silent no-ops, changed context and a timeout after a successful write. Unknown mutation outcomes trigger readback rather than blind retries.

Exit: client contract tests pass without network access; no secret data in fixtures or logs.

### S2. MCP and packaging

Wrap the client in stdio MCP. Keep logs on stderr. Validate schemas and structured error results. Publish capability/version discovery, configuration for the chosen session approach and shutdown behavior. Validate protocol compatibility across the server and any bridge before accepting commands. Build a Windows artifact first and record how browser dependencies are installed without shell commands from users. If an extension is required, the installer registers its native helper; provide a guided enablement flow, compatible version ranges, missing/disabled-extension recovery and a distribution/update plan. Do not require unpacked extension loading or developer mode for the consumer release. Include license notices and checksums; test the artifact on a clean machine.

Exit: a generic MCP client and Korikone's eventual adapter can both launch it without source checkout or developer tooling.

### S3. Observed acceptance and release

Use an owned account to verify the packaged artifact against one small basket. Test reconnect, process restart, partial failure and manual handoff. The user restores any test changes after reviewing them. Document supported platforms and known limitations. Publish the first versioned release when the tests pass.

Exit: release artifact, exact revision/checksum, schemas, fixtures, capability matrix and a short integration example are ready for Korikone. Publishing is future project work, not an action performed by this design task.

## Korikone handoff

Korikone pins the released artifact and translates its schemas into `StoreProvider`. Its contract suite tests the same scenarios as K-Ruoka. Server upgrades require the shared suite and a controlled live smoke test before distribution. App and server versions may advance independently. Publish supported schema/protocol ranges and capability requirements. Korikone checks compatibility before enabling operations; an incompatible update must pause integration with an actionable message rather than attempt writes. Apply the same rule to an extension/native-helper pair if selected.

Do not wait for offers, receipts, order history, remote hosting or perfect coverage of every product type. Do wait for trustworthy login, cart identity, exact quantities, failure reporting, readback and packaging. UI prototyping and the ChatGPT proof of concept can proceed independently, but the full Korikone implementation follows this prerequisite.
