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
import { createServer, type SiteWindow } from "../server.js";

/** 2026-10-08 09:00 in Finland, a Thursday; the 8th is an even day, so its 16–18 slot is full. */
const MORNING = new Date("2026-10-08T06:00:00Z");

async function connect(clock: { now: Date }, selection: StoreSelection = new MemoryStoreSelection(), site?: SiteWindow) {
  const now = () => clock.now;
  const client = new FixtureSKaupatClient(undefined, now);
  const server = createServer(client, new FixtureAuth(), { selection, lists: client, delivery: client, now, site });
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
  alcoholSellingAllowed: "ALLOWED", // as seen live
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
  assert.equal(calendar!.area.alcoholAllowed, true);
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

test("open_site fills in the chosen pickup time on the site before opening it", async () => {
  const storage = new Map<string, string>([
    ["store-storage", JSON.stringify({ state: { storeId: "513971200", selectedBrand: "s-market" }, version: 0 })],
    ["uc_settings", "{}"],
  ]);
  const opened: string[] = [];
  const site: SiteWindow = {
    open: async (url) => void opened.push(url),
    storage: async () => ({ entries: [...storage.entries()], userPagePath: null }),
    writeStorage: async (entries) => entries.forEach(([k, v]) => storage.set(k, v)),
  };
  const mcp = await connect({ now: MORNING }, new MemoryStoreSelection(), site);

  const plain = await call(mcp, "open_site");
  assert.equal(plain.data.prefilled, false);

  await call(mcp, "select_store", { storeId: "fixture-store-1" });
  const slots = await call(mcp, "get_delivery_slots", { areaId: "demo-pickup-fixture-store-1", fromDate: "2026-10-09", days: 1 });
  const slot = slots.data.days[0].slots[0];
  await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-1", slotId: slot.slotId });

  const res = await call(mcp, "open_site");
  assert.equal(res.isError, false);
  assert.equal(res.data.prefilled, true);
  assert.match(res.data.nextStep.fi, /Valittu aika on valmiina/);
  assert.equal(opened.length, 2);
  const store = JSON.parse(storage.get("store-storage")!);
  assert.equal(store.state.storeId, "fixture-store-1");
  assert.equal(store.state.deliveryStore.areaId, "demo-pickup-fixture-store-1");
  const delivery = JSON.parse(storage.get("delivery-storage")!);
  assert.equal(delivery.state.selectedAreaId, "demo-pickup-fixture-store-1");
  assert.deepEqual(
    [delivery.state.deliveryDetailsInfo.deliverySlotId, delivery.state.deliveryDetailsInfo.deliveryDate, delivery.state.deliveryDetailsInfo.deliveryTime],
    [slot.slotId, "2026-10-09", "10:00"],
  );
  assert.equal(JSON.parse(storage.get("delivery-state")!).method, "PICKUP");
  assert.equal(storage.get("uc_settings"), "{}");

  const skipped = await call(mcp, "open_site", { applyChoice: false });
  assert.equal(skipped.data.prefilled, false);
});

test("from an address: methods offered there, nearest pickup places, home delivery and express", async () => {
  const mcp = await connect({ now: MORNING });
  const none = await call(mcp, "find_address", { query: "Helsinki 99" });
  assert.deepEqual(none.data.addresses, []);
  assert.ok(none.data.hint.fi);

  const found = await call(mcp, "find_address", { query: "esimerkkitie 5" });
  assert.equal(found.data.addresses.length, 1);
  const location = found.data.addresses[0].location;
  assert.deepEqual(location, { postalCode: "00100", latitude: 60.171, longitude: 24.941 });

  const res = await call(mcp, "get_delivery_options", { location });
  assert.equal(res.isError, false);
  assert.equal(res.data.date, "2026-10-08");
  assert.deepEqual(
    res.data.methods.map((m: any) => [m.method, m.available]),
    [
      ["pickup", true],
      ["home_delivery", true],
      ["express", true],
    ],
  );
  assert.deepEqual(res.data.siteOnlyMethods, ["express"]);
  // Nearest first: the Helsinki store's two areas, then the other Helsinki store.
  assert.deepEqual(
    res.data.pickupOptions.slice(0, 3).map((o: any) => o.areaId),
    ["demo-pickup-fixture-store-1", "demo-locker-fixture-store-1", "demo-pickup-fixture-store-3"],
  );
  assert.ok(res.data.pickupOptions[0].distanceMeters < 200);
  assert.equal(res.data.pickupOptions[0].freeTimesOnDate, 2);
  assert.deepEqual(
    res.data.homeDeliveryOptions.map((o: any) => [o.areaId, o.method, o.freeTimesOnDate]),
    [["demo-home-fixture-store-1", "home_delivery", 2]],
  );
  assert.equal(res.data.expressStores[0].kind, "one_hour");
  assert.equal(res.data.partial, undefined);
  assert.equal(JSON.stringify(res.data).includes("Esimerkkitie"), false);

  // A home delivery time can be chosen like a pickup time, and the instruction says Kotiinkuljetus.
  const home = await call(mcp, "get_delivery_slots", { areaId: "demo-home-fixture-store-1", fromDate: "2026-10-09", days: 1 });
  assert.equal(home.data.days[0].slots[0].price, 8.9);
  const chosenHome = await call(mcp, "select_delivery", { areaId: "demo-home-fixture-store-1", slotId: home.data.days[0].slots[0].slotId });
  assert.equal(chosenHome.isError, false);
  assert.match(chosenHome.data.delivery.siteInstruction.fi, /Kotiinkuljetus/);

  // A place found by address can be chosen; the store follows it.
  const slots = await call(mcp, "get_delivery_slots", { areaId: "demo-pickup-fixture-store-3", fromDate: "2026-10-09", days: 1 });
  const chosen = await call(mcp, "select_delivery", { areaId: "demo-pickup-fixture-store-3", slotId: slots.data.days[0].slots[0].slotId });
  assert.equal(chosen.isError, false);
  assert.equal((await call(mcp, "get_selected_store")).data.selectedStore.id, "fixture-store-3");

  const tampere = await call(mcp, "get_delivery_options", { location: { postalCode: "33100", latitude: 61.49, longitude: 23.77 } });
  assert.deepEqual(tampere.data.siteOnlyMethods, []);
  assert.deepEqual(tampere.data.homeDeliveryOptions, []);
});

const coordinateSlot = (id: string, start: string, price: number) => ({
  id,
  price,
  closingTime: `2099-10-09T${String(Number(start.slice(0, 2)) - 3).padStart(2, "0")}:00:00.000+03:00`,
  deliveryTimeStart: `2099-10-09T${start}:00.000+03:00`,
  deliveryTimeEnd: `2099-10-09T${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}:00:00.000+03:00`,
  isAlcoholSellingAllowed: true,
});

test("the HTTP client maps address search, delivery methods, nearby pickup and home delivery", async () => {
  const sent: any[] = [];
  const client = new HttpSKaupatClient({
    fetchImpl: scriptedFetch(
      [
        {
          data: {
            addressAutosuggest: [
              { id: "area-mg2X=", title: "Prisma Tripla noutolokero", streetAddress: "Firdonkatu 2b", postalCode: "00520", city: "Helsinki", latitude: 60.19, longitude: 24.93, resultType: "place" },
              { id: "here:x1", title: "Testikatu 1, FI-00930 Helsinki, Suomi", streetAddress: "Testikatu 1", postalCode: "00930", city: "Helsinki", latitude: 60.2, longitude: 25.08, resultType: "houseNumber" },
            ],
          },
        },
        {
          data: {
            lookupLocationDeliveryAvailability: {
              deliveryOptions: [
                { deliveryOptionType: "PICKUP_SLOTS", name: "Nouto", deliveryMethods: [{ id: "PICKUP_PLANNED", deliveryType: "PICKUP_PLANNED" }], slotsDeliveryOptionAvailability: { status: "AVAILABLE", summary: "0–5,90 € • Tänään" } },
                { deliveryOptionType: "HOME_DELIVERY_SLOTS", name: "Kotiinkuljetus", deliveryMethods: [{ id: "HOME_DELIVERY_PLANNED", deliveryType: "HOME_DELIVERY_PLANNED" }], slotsDeliveryOptionAvailability: { status: "AVAILABLE", summary: "8,90–14,90 € • Huomenna" } },
                { deliveryOptionType: "FAST_TRACK_STORES", name: "Pikatoimitus", deliveryMethods: [{ id: "HOME_DELIVERY_ONE_HOUR", deliveryType: "HOME_DELIVERY_ONE_HOUR" }], storeDeliveryOptionAvailability: { status: "UNAVAILABLE", summary: "Ei saatavilla" } },
              ],
              storeDeliveryAvailabilities: {
                oneHour: [{ deliveryAreaId: "fast-1", status: "AVAILABLE", shortSummary: "Noin tunti tilauksesta", longSummary: null, deliveryFee: { formatted: "9,90 €" }, store: { id: "726109200", name: "Prisma Herttoniemi" } }],
                robot: null,
              },
            },
          },
        },
        {
          data: {
            pickupSlotsForCoordinates: {
              slotsInPickupPoints: [
                {
                  distance: 3100.4,
                  store: { id: "726109200", brand: "prisma" },
                  pickupPoint: { id: "22595800-area", name: "Prisma Herttoniemi noutolokero", description: " ", address: { street: " Insinöörinkatu 2", city: "Helsinki", postalCode: "00880" } },
                  slots: [coordinateSlot("2099-10-09:b", "13:00", 0.9), coordinateSlot("2099-10-09:a", "12:00", 0)],
                  fastTrackSlots: [coordinateSlot("2099-10-09:f", "11:00", 4.9)],
                },
                { distance: 5000, store: { id: "1" }, pickupPoint: null, slots: [] },
              ],
            },
          },
        },
        {
          data: {
            homeDeliverySlotsForPostalCode: {
              homeDeliverySlotsInStores: [
                {
                  groupInfo: { storeId: "726109200", storeName: "Prisma Herttoniemi", storeBrand: "prisma", isForContractCustomers: false, deliveryAreaIds: ["home-area-1"] },
                  slots: [coordinateSlot("2099-10-09:h2", "18:00", 10.9), coordinateSlot("2099-10-09:h1", "14:00", 8.9)],
                  fastTrackSlots: [],
                },
                { groupInfo: { storeId: "9", storeName: "Yritysasiakkaat", isForContractCustomers: true, deliveryAreaIds: ["b2b"] }, slots: [] },
              ],
            },
          },
        },
      ],
      sent,
    ),
  });
  const [address, place] = await client.findAddresses('Testikatu "1"');
  assert.match(sent[0].query, /addressAutosuggest\(countryCode: "FIN", query: "Testikatu \\"1\\"", searchContext: DELIVERY_METHOD_SELECTION\)/);
  // Street addresses before the pickup places S-kaupat suggests whatever was typed.
  assert.equal(address!.kind, "houseNumber");
  assert.equal(place!.kind, "place");
  const location = { postalCode: address!.postalCode!, latitude: address!.latitude!, longitude: address!.longitude! };

  const { methods, expressStores } = await client.getDeliveryMethods(location);
  assert.match(sent[1].query, /\.\.\. on SlotBasedDeliveryOption \{ slotsDeliveryOptionAvailability/);
  assert.match(sent[1].query, /postalCode: "00930", coordinates: \{ latitude: 60.2, longitude: 25.08 \}/);
  assert.deepEqual(
    methods.map((m) => [m.method, m.available, m.summary, m.variants]),
    [
      ["pickup", true, "0–5,90 € • Tänään", ["PICKUP_PLANNED"]],
      ["home_delivery", true, "8,90–14,90 € • Huomenna", ["HOME_DELIVERY_PLANNED"]],
      ["express", false, "Ei saatavilla", ["HOME_DELIVERY_ONE_HOUR"]],
    ],
  );
  assert.deepEqual(expressStores, [
    { kind: "one_hour", areaId: "fast-1", storeId: "726109200", storeName: "Prisma Herttoniemi", available: true, summary: "Noin tunti tilauksesta", details: null, fee: "9,90 €" },
  ]);

  const places = await client.getPickupPlacesNear(location, "2099-10-09", 8);
  assert.match(sent[2].query, /pickupSlotsForCoordinates\(startDate: "2099-10-09", endDate: "2099-10-09", closeToCoordinates: \{ latitude: 60.2, longitude: 25.08 \}, limit: 8\)/);
  assert.equal(places.length, 1);
  const pickup = places[0]!;
  assert.equal(pickup.distanceMeters, 3100);
  assert.equal(pickup.area.areaId, "22595800-area");
  assert.equal(pickup.area.storeId, "726109200");
  assert.equal(pickup.area.description, null);
  assert.equal(pickup.area.address!.street, "Insinöörinkatu 2");
  assert.deepEqual(
    pickup.slots.map((s) => [s.slotId, s.price, s.status, s.start]),
    [
      ["2099-10-09:a", 0, "available", "2099-10-09T09:00:00.000Z"],
      ["2099-10-09:b", 0.9, "available", "2099-10-09T10:00:00.000Z"],
    ],
  );
  assert.equal(pickup.area.nextSlot!.slotId, "2099-10-09:a");
  assert.deepEqual(pickup.expressSlots.map((s) => [s.slotId, s.express]), [["2099-10-09:f", true]]);

  const homes = await client.getHomeDeliveryNear("00930", "2099-10-09", "2099-10-11");
  assert.match(sent[3].query, /homeDeliverySlotsForPostalCode\(postalCode: "00930", startDate: "2099-10-09", endDate: "2099-10-11"\)/);
  assert.equal(homes.length, 1);
  assert.equal(homes[0]!.area.areaId, "home-area-1");
  assert.equal(homes[0]!.area.method, "home_delivery");
  assert.deepEqual(
    homes[0]!.slots.map((s) => [s.slotId, s.price, s.areaId]),
    [
      ["2099-10-09:h1", 8.9, "home-area-1"],
      ["2099-10-09:h2", 10.9, "home-area-1"],
    ],
  );
  assert.equal(homes[0]!.area.nextSlot!.slotId, "2099-10-09:h1");
});
