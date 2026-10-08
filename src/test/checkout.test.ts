import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureAuth } from "../auth/fixture-auth.js";
import { HttpCheckoutApi, paymentState } from "../checkout/http.js";
import { MemoryOrderStore } from "../checkout/order-store.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import type { GraphQLBody } from "../client/http-client.js";
import { DemoCheckout } from "../demo/checkout.js";
import { MemoryStoreSelection } from "../selection.js";
import { createServer, type SiteWindow } from "../server.js";

const MORNING = new Date("2026-10-08T06:00:00Z");
const SLOT = "demo-pickup-fixture-store-1-2026-10-09-16";
const ITEMS = [
  { productId: "0000000000017", quantity: 2 },
  { productId: "0000000000024", quantity: 1, allowSubstitutes: false },
];

async function connect(options: { ordering?: boolean; opened?: string[] } = {}) {
  const now = () => MORNING;
  const client = new FixtureSKaupatClient(undefined, now);
  const checkout = new DemoCheckout();
  const opened = options.opened ?? [];
  const site: SiteWindow = {
    open: async (url) => void opened.push(url),
    storage: async () => ({ entries: [], userPagePath: null }),
    writeStorage: async () => {},
  };
  const server = createServer(client, new FixtureAuth(), {
    selection: new MemoryStoreSelection(),
    lists: client,
    delivery: client,
    now,
    site,
    checkout,
    orders: new MemoryOrderStore(),
    ordering: options.ordering,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  await call(mcp, "start_login");
  return { mcp, checkout, opened };
}

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("checkout needs a chosen time first", async () => {
  const { mcp } = await connect();
  const res = await call(mcp, "get_checkout_options");
  assert.equal(res.isError, true);
  assert.equal(res.data.error.code, "order_not_ready");
  assert.equal(res.data.error.action, "review_order");
  assert.deepEqual(res.data.error.missing, ["delivery"]);
});

test("checkout options: payment methods for a consumer, cards, packaging, contact", async () => {
  const { mcp } = await connect();
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: SLOT });
  const res = await call(mcp, "get_checkout_options");
  assert.equal(res.isError, false);
  // Invoices are for companies only.
  assert.deepEqual(res.data.paymentMethods, ["card", "on_delivery"]);
  assert.equal(res.data.savedCards[0].maskedNumber, "**** **** **** 1234");
  // The first packaging that is not a deposit bag, as on the site.
  assert.equal(res.data.defaultPackagingId, "2000000000002");
  assert.equal(res.data.contact.firstName, "Demo");
  assert.equal(res.data.needsAddress, false);
});

test("review, place with a saved card, payment page in the server's window, confirm, cancel", async () => {
  const opened: string[] = [];
  const { mcp, checkout } = await connect({ opened });
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: SLOT });
  const draft = { items: ITEMS, payment: { method: "card", cardId: "demo-card-1" } };

  const review = await call(mcp, "review_order", draft);
  assert.equal(review.isError, false, JSON.stringify(review.data));
  assert.equal(review.data.ready, true);
  assert.deepEqual(review.data.missing, []);
  assert.equal(review.data.summarySource, "s-kaupat");
  assert.equal(review.data.summary.total[0].title, "Yhteensä");
  assert.equal(review.data.payment.card.label, "Oma Visa");
  assert.equal(review.data.items.length, 2);
  assert.ok(review.data.confirmationCode);
  assert.deepEqual(checkout.calls, [], "review writes nothing");

  // A changed order needs a new review.
  const changed = await call(mcp, "place_order", { ...draft, items: [ITEMS[0]], confirmationCode: review.data.confirmationCode });
  assert.equal(changed.data.error.code, "confirmation_required");
  assert.deepEqual(checkout.calls, []);

  const review2 = await call(mcp, "review_order", draft);
  const placed = await call(mcp, "place_order", { ...draft, confirmationCode: review2.data.confirmationCode });
  assert.equal(placed.isError, false, JSON.stringify(placed.data));
  assert.deepEqual(checkout.calls, [`reserve:${SLOT}`, "order:card", "payment"]);
  assert.equal(placed.data.order.payment, "awaiting_payment");
  assert.equal(placed.data.order.accessToken, undefined, "the order's token is never shown");
  assert.equal(placed.data.payment.openedInWindow, true);
  assert.deepEqual(opened, [placed.data.payment.url]);
  assert.equal(placed.data.nextStep.code, "pay");
  const orderId = placed.data.order.orderId;

  // The code is used up.
  const twice = await call(mcp, "place_order", { ...draft, confirmationCode: review2.data.confirmationCode });
  assert.equal(twice.data.error.code, "confirmation_required");

  const confirmed = await call(mcp, "confirm_payment", { orderId });
  assert.equal(confirmed.data.order.payment, "paid");
  assert.equal(confirmed.data.nextStep.code, "done");

  const listed = await call(mcp, "get_order");
  assert.deepEqual(listed.data.orders.map((o: any) => o.orderId), [orderId]);

  const cancelled = await call(mcp, "cancel_order", { orderId });
  assert.equal(cancelled.isError, false, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.cancelled, true);
  assert.equal(cancelled.data.order.state, "cancelled");
});

test("pay later, then pay_order; pay on delivery needs no payment page", async () => {
  const opened: string[] = [];
  const { mcp, checkout } = await connect({ opened });
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: SLOT });

  const card = { items: ITEMS, payment: { method: "card" } };
  const r1 = await call(mcp, "review_order", card);
  assert.equal(r1.data.payment.newCard, true);
  const later = await call(mcp, "place_order", { ...card, confirmationCode: r1.data.confirmationCode, paymentPage: "later" });
  assert.equal(later.data.payment.status, "not_started");
  assert.deepEqual(opened, []);
  const paid = await call(mcp, "pay_order", { orderId: later.data.order.orderId, paymentPage: "app" });
  assert.equal(paid.data.payment.status, "payment_page");
  assert.match(paid.data.payment.returnUrlPrefix, /^https:\/\/www\.s-kaupat\.fi\/payment\/auth\//);
  assert.deepEqual(opened, [], "app shows the page itself");

  const cash = { items: ITEMS, payment: { method: "on_delivery" } };
  const r2 = await call(mcp, "review_order", cash);
  const placed = await call(mcp, "place_order", { ...cash, confirmationCode: r2.data.confirmationCode });
  assert.equal(placed.data.payment.required, false);
  assert.equal(placed.data.order.payment, "not_needed");
  assert.equal(placed.data.nextStep.code, "placed");
  assert.equal(checkout.calls.filter((c) => c === "payment").length, 1);
});

test("review lists what is missing: address for home delivery, payment not offered", async () => {
  const { mcp } = await connect();
  const found = await call(mcp, "find_address", { query: "esimerkkitie 5" });
  const location = found.data.addresses[0].location;
  const delivery = await call(mcp, "get_delivery_options", { location });
  const home = delivery.data.homeDeliveryOptions[0];
  const slots = await call(mcp, "get_delivery_slots", { areaId: home.areaId, fromDate: "2026-10-09", days: 1 });
  const slot = slots.data.days[0].slots.find((s: any) => s.status === "available");
  await call(mcp, "select_delivery", { areaId: home.areaId, slotId: slot.slotId });
  const review = await call(mcp, "review_order", { items: ITEMS, payment: { method: "invoice" } });
  assert.equal(review.data.ready, false);
  assert.ok(review.data.missing.includes("address"));
  assert.deepEqual(review.data.problems.map((p: any) => p.code), ["payment_method_not_offered"]);
  assert.equal(review.data.confirmationCode, null);
});

test("Pikatoimitus is ordered in the app: home address needed, no time reserved, no invoice", async () => {
  const { mcp, checkout } = await connect();
  const found = await call(mcp, "find_address", { query: "esimerkkitie 5" });
  const delivery = await call(mcp, "get_delivery_options", { location: found.data.addresses[0].location });
  assert.deepEqual(delivery.data.siteOnlyMethods, []);
  const express = delivery.data.expressStores[0];
  const slots = await call(mcp, "get_delivery_slots", { areaId: express.areaId, fromDate: "2026-10-08", days: 1 });
  assert.equal(slots.data.area.method, "express");
  const slot = slots.data.days[0].slots.find((s: any) => s.status === "available");
  assert.equal(slot.express, true);
  const chosen = await call(mcp, "select_delivery", { areaId: express.areaId, slotId: slot.slotId });
  assert.equal(chosen.isError, false);

  const options = await call(mcp, "get_checkout_options");
  assert.equal(options.data.needsAddress, true);
  assert.deepEqual(options.data.paymentMethods, ["card", "on_delivery"]);

  const draft = { items: ITEMS, payment: { method: "on_delivery" } };
  const noAddress = await call(mcp, "review_order", draft);
  assert.deepEqual(noAddress.data.missing, ["address"]);
  const withAddress = { ...draft, address: { street: "Esimerkkitie 5", postalCode: "00100", city: "Helsinki" } };
  const review = await call(mcp, "review_order", withAddress);
  assert.equal(review.data.ready, true);
  const placed = await call(mcp, "place_order", { ...withAddress, confirmationCode: review.data.confirmationCode });
  assert.equal(placed.isError, false);
  assert.equal(placed.data.order.payment, "not_needed");
  assert.deepEqual(checkout.calls, ["order:on_delivery"], "an express time is not reserved first");
});

test("place_order can be turned off", async () => {
  const { mcp } = await connect({ ordering: false });
  const res = await call(mcp, "place_order", { items: ITEMS, payment: { method: "card" }, confirmationCode: "x" });
  assert.equal(res.data.error.code, "orders_disabled");
});

function fakeApi(answers: Record<string, GraphQLBody>, seen: { op: string; vars: any; opts: any }[] = []) {
  return {
    async graphql(op: string, _q: string, vars: Record<string, unknown>, opts: any = {}) {
      seen.push({ op, vars, opts });
      const a = answers[op];
      if (!a) throw new Error(`unexpected ${op}`);
      return a;
    },
  };
}

test("HTTP adapter: order input, order token header, error types", async () => {
  const seen: { op: string; vars: any; opts: any }[] = [];
  const api = new HttpCheckoutApi(
    fakeApi(
      {
        CreateOrder: {
          data: {
            createOrder: {
              id: "o1",
              orderNumber: 123,
              orderStatus: "NEW",
              paymentStatus: null,
              paymentMethod: "CARD_PAYMENT",
              accessToken: "secret",
              deliveryDate: "2026-10-09",
              deliveryTime: "16:00-18:00",
              storeId: "s1",
            },
          },
        },
        CancelOrder: { data: { cancelOrder: { id: "o1", orderStatus: "CANCELLED" } } },
        CreatePayment: {
          data: null,
          errors: [{ message: "x", extensions: { errorType: "PaymentCardNotFoundError" } }],
        },
      },
      seen,
    ),
  );
  const created = await api.createOrder("tok", {
    storeId: "s1",
    slotId: "slot1",
    reservationId: "r1",
    items: [{ productId: "e1", quantity: 1.5, allowSubstitutes: true, unit: "KG" }],
    packagingId: "p1",
    contact: { firstName: "A", lastName: "B", phone: "0401234567", email: "a@b.fi" },
    address: null,
    payment: "card",
    note: null,
    discountCode: null,
  });
  assert.equal(created.orderNumber, "123");
  assert.equal(created.payment, "awaiting_payment");
  assert.equal(created.accessToken, "secret");
  const order = seen[0]!.vars.order;
  assert.equal(order.paymentMethod, "CARD_PAYMENT");
  assert.deepEqual(order.cartItems, [
    { ean: "e1", itemCount: "1.5", replace: true, additionalInfo: null, basicQuantityUnit: "KG" },
    { ean: "p1", itemCount: "1", replace: false, additionalInfo: null, basicQuantityUnit: null },
  ]);
  assert.equal(order.customer.addressLine1, "");
  assert.equal(order.reservationId, "r1");

  assert.equal(await api.cancelOrder("tok", "o1", "secret"), "cancelled");
  assert.equal(seen[1]!.opts.orderToken, "secret");

  await assert.rejects(api.createPayment("tok", "o1", "card1", false), (e: any) => e.code === "payment_failed" && e.details.reason === "card_not_found");
});

test("HTTP adapter: unpaid orders and lost answers", async () => {
  const unpaid = new HttpCheckoutApi(
    fakeApi({
      CreateOrder: {
        data: null,
        errors: [
          {
            message: "unpaid",
            extensions: {
              errorType: "UnpaidPaymentLinkError",
              unpaidOrders: [{ orderNumber: "9", unpaidAmountInCents: 1234, paymentLinkSentToCustomer: "https://pay.example/9" }],
            },
          },
        ],
      },
    }),
  );
  const order = {
    storeId: "s",
    slotId: "x",
    reservationId: null,
    items: [],
    packagingId: "p",
    contact: { firstName: "A", lastName: "B", phone: "1", email: "e" },
    address: null,
    payment: "on_delivery" as const,
    note: null,
    discountCode: null,
  };
  await assert.rejects(unpaid.createOrder("t", order), (e: any) => e.code === "unpaid_orders" && e.details.unpaidOrders[0].unpaidEuros === 12.34);

  const lost = new HttpCheckoutApi({
    async graphql() {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });
  await assert.rejects(lost.createOrder("t", order), (e: any) => e.code === "order_uncertain");
});

test("payment states follow the site's reading", () => {
  assert.equal(paymentState("card", null, "NEW"), "awaiting_payment");
  assert.equal(paymentState("card", "CARD_AUTHORIZED", "NEW"), "paid");
  assert.equal(paymentState("card", "CARD_AUTHORIZATION_FAILED", "OPEN"), "payment_failed");
  assert.equal(paymentState("on_delivery", null, "NEW"), "not_needed");
  assert.equal(paymentState("card", "PENDING", "CANCELLED"), "cancelled");
});

test("a double-pressed Order button places one order", async () => {
  const { mcp, checkout } = await connect();
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: SLOT });
  const draft = { items: ITEMS, payment: { method: "on_delivery" } };
  const review = await call(mcp, "review_order", draft);
  const args = { ...draft, confirmationCode: review.data.confirmationCode };
  const [a, b] = await Promise.all([call(mcp, "place_order", args), call(mcp, "place_order", args)]);
  assert.deepEqual([a.isError, b.isError].sort(), [false, true]);
  assert.equal((a.isError ? a : b).data.error.code, "confirmation_required");
  assert.equal(checkout.calls.filter((c) => c.startsWith("order:")).length, 1);
});

test("HTTP adapter: S-kaupat's error text loses the user's values", async () => {
  const api = new HttpCheckoutApi(
    fakeApi({
      CreateOrder: {
        data: null,
        errors: [{ message: 'Variable "$order" got invalid value {"customer":{"phone":"0401234567"}}; Field "x" is not defined by type "CustomerInput".' }],
      },
    }),
  );
  const order = {
    storeId: "s",
    slotId: "x",
    reservationId: null,
    items: [],
    packagingId: "p",
    contact: { firstName: "A", lastName: "B", phone: "0401234567", email: "e" },
    address: null,
    payment: "card" as const,
    note: null,
    discountCode: null,
  };
  await assert.rejects(api.createOrder("t", order), (e: any) => e.code === "upstream_error" && !e.message.includes("0401234567") && e.message.includes('Field "x"'));
});
