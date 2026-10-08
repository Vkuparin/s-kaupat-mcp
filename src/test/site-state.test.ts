import assert from "node:assert/strict";
import { test } from "node:test";
import { prefillEntries, readSiteChoice } from "../browser/site-state.js";

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

test("the site's choice is read from its storage keys as seen live", () => {
  const { choice } = readSiteChoice([
    ["store-storage", JSON.stringify({ state: { storeId: "726109200", selectedBrand: "prisma", deliveryStore: { id: "726109200", areaId: "a-1" } }, version: 0 })],
    [
      "delivery-storage",
      JSON.stringify({
        state: {
          selectedAreaId: "a-1",
          deliveryDetailsInfo: { deliveryDate: "2026-10-08", deliveryMethod: "PICKUP", deliverySlotId: "2026-10-08:s-1", deliveryTime: "12:00" },
          deliveryAddress: { street: "Kotikatu 1" },
        },
      }),
    ],
  ]);
  assert.equal(choice.storeId, "726109200");
  assert.equal(choice.selectedAreaId, "a-1");
  assert.equal(choice.deliverySlotId, "2026-10-08:s-1");
  assert.equal(choice.deliveryMethod, "PICKUP");
});

test("pre-filling keeps the site's other fields and the same store's details", () => {
  const entries: [string, string][] = [
    ["store-storage", JSON.stringify({ state: { storeId: "726109200", deliveryStore: { __typename: "DeliveryStore", id: "726109200", areaId: "old", availablePaymentMethods: ["X"], name: "Prisma Herttoniemi", brand: "prisma" }, other: 1 }, version: 3 })],
    ["delivery-storage", JSON.stringify({ state: { deliveryDetailsInfo: { additionalInfo: "ovikoodi", deliveryMethod: "HOME_DELIVERY" } }, version: 2 })],
    ["delivery-state", JSON.stringify({ searchInput: "x", method: "HOME_DELIVERY", homeDeliveryType: "NORMAL" })],
  ];
  const out = new Map(
    prefillEntries(entries, {
      storeId: "726109200",
      storeName: "Prisma Herttoniemi",
      chain: "PRISMA",
      areaId: "a-1",
      slotId: "2026-10-09:s",
      date: "2026-10-09",
      time: "16:00",
      price: 0,
      postalCode: "00880",
      city: "Helsinki",
    }).map(([k, v]) => [k, JSON.parse(v)]),
  );
  const store = out.get("store-storage");
  assert.equal(store.version, 3);
  assert.equal(store.state.other, 1);
  assert.deepEqual(store.state.deliveryStore.availablePaymentMethods, ["X"]);
  assert.equal(store.state.deliveryStore.areaId, "a-1");
  assert.equal(store.state.selectedBrand, "prisma");
  const info = out.get("delivery-storage").state.deliveryDetailsInfo;
  assert.equal(out.get("delivery-storage").version, 2);
  assert.equal(info.additionalInfo, "ovikoodi");
  assert.equal(info.deliveryMethod, "PICKUP");
  assert.equal(info.deliverySlotPrice, 0);
  assert.equal(out.get("delivery-state").searchInput, "x");
  assert.equal(out.get("delivery-state").method, "PICKUP");
});
