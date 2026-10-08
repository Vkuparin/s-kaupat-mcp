import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FixtureAuth } from "../auth/fixture-auth.js";
import { FixtureSKaupatClient } from "../client/fixture-client.js";
import { HttpSKaupatClient } from "../client/http-client.js";
import { FileStoreSelection, MemoryStoreSelection, type StoreSelection } from "../selection.js";
import { createServer } from "../server.js";

/** 2026-10-08 09:00 in Finland, a Thursday; the 8th is an even day, so its 16–18 slot is full. */
const MORNING = new Date("2026-10-08T06:00:00Z");

async function connect(clock: { now: Date }, selection: StoreSelection = new MemoryStoreSelection()) {
  const now = () => clock.now;
  const client = new FixtureSKaupatClient(undefined, now);
  const server = createServer(client, new FixtureAuth(), { selection, lists: client, delivery: client, now });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

async function call(mcp: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await mcp.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: res.structuredContent as any };
}

test("walks the pickup choice: options, calendar, choice, finishing instructions and basket check", async () => {
  const mcp = await connect({ now: MORNING });
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  await call(mcp, "start_login");

  const options = await call(mcp, "get_delivery_options");
  assert.equal(options.isError, false);
  assert.deepEqual(
    options.data.options.map((o: any) => [o.method, o.areaId]),
    [
      ["pickup", "demo-pickup-fixture-store-1"],
      ["pickup", "demo-locker-fixture-store-1"],
    ],
  );
  // Ordering closes three hours ahead, so at 09:00 the next free time today is 14–16.
  assert.equal(options.data.options[0].nextSlot.start, "2026-10-08T11:00:00.000Z");
  assert.deepEqual(options.data.methodsNotYetSupported, ["home_delivery", "express"]);

  const slots = await call(mcp, "get_delivery_slots", { areaId: "demo-pickup-fixture-store-1", days: 2 });
  assert.equal(slots.isError, false);
  assert.deepEqual(
    slots.data.days.map((d: any) => d.date),
    ["2026-10-08", "2026-10-09"],
  );
  const today = slots.data.days[0].slots;
  assert.deepEqual(
    today.map((s: any) => s.status),
    ["closed", "closed", "available", "full", "available"],
  );
  assert.equal(slots.data.days[0].availableCount, 2);
  assert.equal(slots.data.days[1].availableCount, 5);

  const tomorrow = slots.data.days[1].slots[3];
  const chosen = await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: tomorrow.slotId });
  assert.equal(chosen.isError, false);
  assert.equal(chosen.data.delivery.status, "chosen");
  assert.equal(chosen.data.delivery.date, "2026-10-09");
  assert.equal(chosen.data.delivery.price, 5.9);
  assert.equal(
    chosen.data.delivery.siteInstruction.fi,
    'Valitse sivulla "Valitse toimitustapa": Nouto, Prisma Esimerkki Helsinki, pe 9.10. klo 16:00–18:00.',
  );

  const status = await call(mcp, "get_setup_status");
  assert.equal(status.data.delivery.slotId, tomorrow.slotId);
  assert.equal(status.data.nextStep, null);

  const again = await call(mcp, "get_delivery_slots", { areaId: "demo-pickup-fixture-store-1", fromDate: "2026-10-09", days: 1 });
  assert.equal(again.data.selectedSlotId, tomorrow.slotId);

  const list = await call(mcp, "create_shopping_list", { name: "Viikonloppu", items: [{ productId: "0000000000017" }] });
  assert.equal(list.isError, false);
  assert.match(list.data.nextStep.fi, /Valitse toimitustapa": Nouto, Prisma Esimerkki Helsinki, pe 9\.10\. klo 16:00–18:00/);

  const basket = await call(mcp, "check_basket", { listId: list.data.list.id });
  assert.equal(basket.isError, false);
  assert.equal(basket.data.checkedFor.slotId, tomorrow.slotId);
  assert.deepEqual(basket.data.summary, { ok: 1, problems: 0 });
});

test("a time that is full or closed can't be chosen", async () => {
  const mcp = await connect({ now: MORNING });
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  for (const hour of [16, 10]) {
    const res = await call(mcp, "select_delivery", {
      areaId: "demo-pickup-fixture-store-1",
      slotId: `demo-pickup-fixture-store-1-2026-10-08-${hour}`,
    });
    assert.equal(res.isError, true);
    assert.equal(res.data.error.code, "slot_unavailable");
    assert.equal(res.data.error.action, "choose_delivery_time");
  }
  const unknown = await call(mcp, "get_delivery_slots", { areaId: "no-such-area" });
  assert.equal(unknown.data.error.code, "delivery_area_not_found");
  assert.equal(unknown.data.error.action, "choose_delivery");
});

test("a chosen time that has passed asks for a new one, and a new store forgets it", async () => {
  const clock = { now: MORNING };
  const mcp = await connect(clock);
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  await call(mcp, "start_login");
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: "demo-pickup-fixture-store-1-2026-10-08-14" });

  clock.now = new Date("2026-10-08T11:30:00Z");
  const status = await call(mcp, "get_setup_status");
  assert.equal(status.data.delivery.status, "expired");
  assert.equal(status.data.nextStep, "choose_delivery");
  // An expired choice is not used for the basket check or the finishing instructions.
  const basket = await call(mcp, "check_basket", { items: [{ productId: "0000000000017" }] });
  assert.equal(basket.data.checkedFor, null);

  await call(mcp, "select_store", { storeId: "fixture-store-2" });
  const after = await call(mcp, "get_setup_status");
  assert.equal(after.data.delivery, null);
  assert.equal(after.data.nextStep, null);
});

test("the delivery choice survives a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "skaupat-delivery-")), "settings.json");
  const clock = { now: MORNING };
  const first = await connect(clock, new FileStoreSelection(path));
  await call(first, "select_store", { storeId: "fixture-store-1" });
  await call(first, "select_delivery", { areaId: "demo-locker-fixture-store-1", slotId: "demo-locker-fixture-store-1-2026-10-09-10" });

  const second = await connect(clock, new FileStoreSelection(path));
  const status = await call(second, "get_setup_status");
  assert.equal(status.data.store.id, "fixture-store-1");
  assert.equal(status.data.delivery.areaId, "demo-locker-fixture-store-1");

  await call(second, "clear_delivery");
  const cleared = await call(await connect(clock, new FileStoreSelection(path)), "get_setup_status");
  assert.equal(cleared.data.delivery, null);
  assert.equal(cleared.data.store.id, "fixture-store-1");
});

test("check_basket takes either a list or products", async () => {
  const mcp = await connect({ now: MORNING });
  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  const neither = await call(mcp, "check_basket");
  assert.equal(neither.data.error.code, "invalid_argument");
  const products = await call(mcp, "check_basket", { items: [{ productId: "0000000000017" }, { productId: "9999999999999" }] });
  assert.deepEqual(
    products.data.items.map((i: any) => i.status),
    ["ok", "not_found"],
  );
});

/** Answers each POST with the next body, recording what was sent. */
function scriptedFetch(responses: unknown[], sent: any[]): typeof fetch {
  return (async (_url: URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const apiArea = {
  areaId: "4f1c-area",
  name: "Prisma Herttoniemi nouto",
  storeId: "726109200",
  price: "3.90",
  description: " ",
  deliveryMethod: "PICKUP",
  isFastTrack: false,
  alcoholSellingAllowed: true,
  store: { id: "726109200", name: "Prisma Herttoniemi" },
  address: { street: "Kauppakartanonkatu 7", postalCode: "00930", city: "Helsinki" },
};

test("the HTTP client maps S-kaupat's delivery areas and slots", async () => {
  const sent: any[] = [];
  const client = new HttpSKaupatClient({
    fetchImpl: scriptedFetch(
      [
        {
          data: {
            deliveryArea: {
              ...apiArea,
              deliverySlots: [
                {
                  date: "2099-10-09",
                  deliveryTimes: [
                    {
                      slotId: "s2",
                      isClosed: false,
                      availability: "FULL",
                      startDateTime: "2099-10-09T13:00:00.000Z",
                      endDateTime: "2099-10-09T15:00:00.000Z",
                      closingTimestamp: Date.parse("2099-10-09T10:00:00Z"),
                      price: 5.9,
                      isFastTrack: false,
                    },
                    {
                      slotId: "s1",
                      isClosed: false,
                      availability: "AVAILABLE",
                      startDateTime: "2099-10-09T07:00:00.000Z",
                      endDateTime: "2099-10-09T09:00:00.000Z",
                      closingTimestamp: null,
                      price: "4,90",
                      isFastTrack: false,
                    },
                    { slotId: "no-start", availability: "AVAILABLE" },
                    { slotId: "s3", isClosed: false, availability: "SOMETHING_NEW", startDateTime: "2099-10-09T15:00:00.000Z" },
                  ],
                },
              ],
            },
          },
        },
      ],
      sent,
    ),
  });
  const calendar = await client.getDeliveryCalendar("4f1c-area", "2099-10-09", "2099-10-10");
  assert.deepEqual(sent[0].variables, { id: "4f1c-area", startDate: "2099-10-09", endDate: "2099-10-10" });
  assert.equal(calendar!.area.method, "pickup");
  assert.equal(calendar!.area.price, 3.9);
  assert.equal(calendar!.area.description, null);
  assert.deepEqual(
    calendar!.slots.map((s) => [s.slotId, s.status, s.price, s.date]),
    [
      ["s1", "available", 4.9, "2099-10-09"],
      ["s2", "full", 5.9, "2099-10-09"],
      ["s3", "unknown", null, "2099-10-09"],
    ],
  );
  assert.equal(calendar!.slots[1]!.closesAt, "2099-10-09T10:00:00.000Z");

  const none = new HttpSKaupatClient({ fetchImpl: scriptedFetch([{ data: { deliveryArea: null } }], []) });
  assert.equal(await none.getDeliveryCalendar("gone", "2099-10-09", "2099-10-09"), null);
});

test("the HTTP client describes a store's pickup areas in one extra request", async () => {
  const sent: any[] = [];
  const client = new HttpSKaupatClient({
    fetchImpl: scriptedFetch(
      [
        { data: { searchPickupDeliveryAreas: { areas: [{ areaId: "4f1c-area" }, { areaId: "lokero" }, { areaId: "4f1c-area" }] } } },
        {
          data: {
            a0: {
              ...apiArea,
              nextDeliverySlot: { slotId: "s1", startDateTime: "2099-10-09T07:00:00.000Z", price: 3.9, availability: "AVAILABLE", isClosed: false },
            },
            a1: { ...apiArea, areaId: "lokero", isFastTrack: true, deliveryMethod: "HOME_DELIVERY", nextDeliverySlot: null },
          },
        },
      ],
      sent,
    ),
  });
  const areas = await client.getPickupAreas("726109200", ["Prisma Herttoniemi", " ", "00930"]);
  assert.equal(sent.length, 2);
  // The same search without text and with each of the store's texts, in one request.
  assert.deepEqual(sent[0].variables, { storeId: "726109200", t0: "Prisma Herttoniemi", t1: "00930" });
  assert.match(sent[0].query, /s: searchPickupDeliveryAreas\(storeId: \$storeId, freetext: null.*s1: searchPickupDeliveryAreas\(storeId: \$storeId, freetext: \$t1/);
  assert.deepEqual(sent[1].variables, { a0: "4f1c-area", a1: "lokero" });
  assert.match(sent[1].query, /a1: deliveryArea\(id: \$a1\)/);
  assert.deepEqual(
    areas.map((a) => [a.areaId, a.method, a.nextSlot?.slotId ?? null, a.nextSlot?.areaId ?? null]),
    [
      ["4f1c-area", "pickup", "s1", "4f1c-area"],
      ["lokero", "express", null, null],
    ],
  );

  const empty = new HttpSKaupatClient({ fetchImpl: scriptedFetch([{ data: { searchPickupDeliveryAreas: { areas: [] } } }], []) });
  assert.deepEqual(await empty.getPickupAreas("1"), []);
});

test("the cart check sends the chosen time", async () => {
  const sent: any[] = [];
  const client = new HttpSKaupatClient({
    fetchImpl: scriptedFetch([{ data: { validateCart: { cartValidationItems: [{ ean: "1", validationError: null }] } } }], sent),
  });
  await client.checkBasket("726109200", [{ id: "1", quantity: 2 }], { date: "2099-10-09", slotId: "s1", areaId: "a" });
  assert.deepEqual(sent[0].variables, {
    storeId: "726109200",
    deliveryDate: "2099-10-09",
    slotId: "s1",
    areaId: "a",
    items: [{ ean: "1", itemCount: "2" }],
  });
});
