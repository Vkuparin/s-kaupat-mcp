import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpSKaupatClient } from "../client/http-client.js";
import { SKaupatError } from "../errors.js";

const apiFixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "api");
const docSamples = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "samples");
const sample = (name: string): unknown => JSON.parse(readFileSync(join(apiFixtures, name), "utf8"));
/** A live-captured response from docs/samples (its "response" part, or another named key). */
const docSample = (name: string, key = "response"): unknown =>
  JSON.parse(readFileSync(join(docSamples, name), "utf8"))[key];

function fakeFetch(body: unknown, status = 200, seen: URL[] = [], bodies: any[] = []): typeof fetch {
  return (async (url: URL, init?: RequestInit) => {
    seen.push(url);
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

test("product search posts its own query and maps the captured sample", async () => {
  const bodies: any[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(docSample("product-search.json"), 200, [], bodies) });
  const res = await client.searchProducts({ storeId: "517609418", query: "maito", limit: 3 });
  assert.equal(bodies[0].operationName, "RemoteFilteredProducts");
  assert.match(bodies[0].query, /products\(queryString: \$queryString/);
  assert.doesNotMatch(JSON.stringify(bodies[0]), /persistedQuery/);
  assert.deepEqual(bodies[0].variables, { storeId: "517609418", queryString: "maito", from: 0, limit: 3 });
  assert.equal(res.total, 1312);
  assert.equal(res.offset, 0);
  assert.equal(res.sort, "relevance");
  assert.equal(res.products.length, 3);
  const { observedAt, ...milk } = res.products[0]!;
  assert.ok(observedAt);
  assert.deepEqual(milk, {
    id: "6414893386488",
    storeId: "517609418",
    name: "Kotimaista kevytmaito 1 L",
    brand: "Kotimaista",
    price: 0.95,
    regularPrice: 0.95,
    campaignPrice: null,
    campaignValidUntil: null,
    lowest30DayPrice: null,
    depositPrice: null,
    priceBasis: "per_item",
    approximatePrice: false,
    comparisonPrice: 0.95,
    comparisonUnit: "LTR",
    packSize: null,
    quantityUnit: "KPL",
    availability: "unknown",
    category: "Maidot",
    categorySlug: "maito-munat-ja-rasvat/maidot-ja-piimat/maidot",
    labels: ["Hyvää Suomesta (Sininen Joutsen)"],
    ageLimited: false,
    frozen: false,
    shelfLocation: { aisle: "63", shelf: "1" },
    imageUrl: "https://cdn.s-cloud.fi/v1/w_300,h_300/assets/dam-id/DyJl47EUq3HBX2A-iCv3Px.jpg",
  });
});

test("product search sends paging and price sort", async () => {
  const bodies: any[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(docSample("product-search.json"), 200, [], bodies) });
  const res = await client.searchProducts({ storeId: "1", query: "maito", limit: 3, offset: 3, sort: "price_desc" });
  assert.deepEqual(bodies[0].variables, {
    storeId: "1",
    queryString: "maito",
    from: 3,
    limit: 3,
    orderBy: "price",
    order: "desc",
  });
  assert.equal(res.offset, 3);
  assert.equal(res.sort, "price_desc");
});

test("an unknown store in product search is store_not_found", async () => {
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch({ data: { store: null } }) });
  await assert.rejects(
    client.searchProducts({ storeId: "999", query: "a", limit: 1 }),
    (e: SKaupatError) => e.code === "store_not_found",
  );
});

test("HTTP 403 becomes blocked", async () => {
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch({}, 403) });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "blocked");
});

test("a rejected query (HTTP 400) is upstream_error", async () => {
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(docSample("errors.json", "validation_unknown_field (HTTP 400)"), 400) });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "upstream_error");
});

test("get_products looks up all EANs in one request", async () => {
  const bodies: any[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(docSample("product-search.json"), 200, [], bodies) });
  const res = await client.getProducts({ storeId: "517609418", ids: ["6414893386488", "0000000000000"] });
  assert.equal(bodies.length, 1);
  assert.match(bodies[0].query, /products\(eans: \$eans/);
  assert.deepEqual(bodies[0].variables, { storeId: "517609418", eans: ["6414893386488", "0000000000000"], limit: 2 });
  assert.deepEqual(res.results.map((r) => r.status), ["found", "not_found"]);
});

test("store search posts its own query and maps the captured sample", async () => {
  const bodies: any[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(sample("store-search.json"), 200, [], bodies) });
  const res = await client.searchStores({ query: "Tampere", chain: "PRISMA", limit: 10 });
  assert.match(bodies[0].query, /searchStores\(query: \$query, brand: \$brand, cursor: \$cursor\)/);
  assert.deepEqual(bodies[0].variables, { query: "Tampere", brand: "PRISMA", cursor: null });
  assert.equal(res.total, 31);
  assert.deepEqual(res.stores[0], {
    id: "649107562",
    name: "ABC Lahdesjärvi Tampere",
    chain: "ABC",
    chainName: "ABC",
    street: "Automiehenkatu 39",
    postalCode: "33840",
    city: "Tampere",
    coordinates: { lat: 61.459378, lon: 23.787731 },
    onlineOrdering: true,
  });
  assert.equal(res.stores[1]?.chainName, "Prisma");
  assert.equal(res.stores[1]?.onlineOrdering, false);
});

test("store search follows the cursor until the limit is reached", async () => {
  const page = (n: number, cursor: string | null) => ({
    data: {
      searchStores: {
        totalCount: 40,
        cursor,
        stores: Array.from({ length: n }, (_, i) => ({ id: `${cursor ?? "last"}-${i}`, name: "S-market X", brand: "s-market" })),
      },
    },
  });
  const bodies: any[] = [];
  const responses = [page(24, "c1"), page(16, null)];
  const fetchImpl = (async (_url: URL, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  const res = await new HttpSKaupatClient({ fetchImpl }).searchStores({ query: "x", limit: 30 });
  assert.equal(res.stores.length, 30);
  assert.equal(bodies[1].variables.cursor, "c1");
  assert.equal(res.stores[0]?.chain, "S_MARKET");
  assert.equal(res.stores[0]?.chainName, "S-market");
});

test("getStores batches IDs into one request and maps opening hours", async () => {
  const bodies: any[] = [];
  const client = new HttpSKaupatClient({ fetchImpl: fakeFetch(sample("store-details.json"), 200, [], bodies) });
  const stores = await client.getStores(["726413330", "517609418", "999"]);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].variables, { s0: "726413330", s1: "517609418", s2: "999" });
  assert.match(bodies[0].query, /s1: store\(id: \$s1\)/);
  const hameenkatu = stores.get("726413330")!;
  assert.equal(hameenkatu.openingHours.length, 7);
  assert.deepEqual(hameenkatu.openingHours[2], {
    date: "2026-10-07",
    day: "WED",
    status: "open",
    ranges: [{ open: "06:00", close: "00:00" }],
  });
  assert.equal(stores.get("517609418")?.openingHours[0]?.status, "open_24h");
  assert.equal(stores.get("517609418")?.chain, "PRISMA");
  assert.equal(stores.has("999"), false);
});

test("S-kaupat product errors become product_unavailable", async () => {
  const client = new HttpSKaupatClient({
    fetchImpl: fakeFetch({ errors: [{ message: "ProductNotInAssortmentError: not sold here" }] }),
  });
  await assert.rejects(
    client.searchProducts({ storeId: "1", query: "a", limit: 1 }),
    (e: SKaupatError) => e.code === "product_unavailable" && e.userMessage.en === "This product is not available in this store.",
  );
});
