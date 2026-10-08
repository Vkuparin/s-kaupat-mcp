import assert from "node:assert/strict";
import { test } from "node:test";
import { readSiteChoice } from "../browser/site-state.js";

test("reads the site's choice and describes its storage without values", () => {
  const apollo = {
    ROOT_QUERY: {
      selectedStoreId: "726109200",
      selectedAreaId: "3f1c-uuid",
      deliverySlotId: null,
      authenticationTokens: { accessToken: "jwt", refreshToken: "secret" },
      'shoppingList({"id":"x"})': { __ref: "ShoppingList:x" },
    },
    "ShoppingList:x": { name: "Viikonloppu", items: [{ ean: "6408", name: "Maito" }] },
  };
  const { choice, storage } = readSiteChoice([
    ["apollo-cache-persist", JSON.stringify(apollo)],
    ["deliveryDetails", JSON.stringify({ deliveryDate: "2026-10-09", deliveryMethod: "PICKUP", address: "Kotikatu 1" })],
    ["auth", "secret-token"],
    ["plain", "hello"],
  ]);
  assert.equal(choice.selectedStoreId, "726109200");
  assert.equal(choice.selectedAreaId, "3f1c-uuid");
  assert.equal(choice.deliverySlotId, null);
  assert.equal(choice.deliveryDate, "2026-10-09");
  assert.equal(choice.deliveryMethod, "PICKUP");

  const text = JSON.stringify(storage);
  for (const secret of ["jwt", "secret", "Viikonloppu", "Maito", "6408", "Kotikatu", "hello"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(storage[2], { key: "auth", shape: "<private>" });
  assert.deepEqual(storage[3], { key: "plain", shape: "string" });
  assert.deepEqual((storage[0]!.shape as any).ROOT_QUERY.authenticationTokens, "<private>");
  assert.deepEqual((storage[0]!.shape as any)["ShoppingList:x"], { name: "string", items: [{ ean: "string", name: "string" }, "…1"] });
});
