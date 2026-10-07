import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpSKaupatClient } from "../client/http-client.js";
import { SKaupatError } from "../errors.js";

const apiFixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "api");
const sample = (name: string): unknown => JSON.parse(readFileSync(join(apiFixtures, name), "utf8"));

function fakeFetch(body: unknown, status = 200, seen: URL[] = [], bodies: any[] = []): typeof fetch {
  return (async (url: URL, init?: RequestInit) => {
    seen.push(url);
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const productResponse = {
  data: {
    store: {
      products: {
        total: 1,
        productListItems: [
          {
            product: {
              ean: "0000000000017",
              name: "Kevytmaito 1 l",
              price: 1.09,
              brandName: "Esimerkki",
              priceUnit: "KPL",
              pricing: { currentPrice: 1.09, campaignPrice: null, comparisonPrice: 1.09, comparisonUnit: "L" },
              hierarchyPath: [{ name: "Maito" }],
              productDetails: { productImages: { mainImage: { urlTemplate: "https://img/{MODIFIERS}/x.{EXTENSION}" } } },
            },
          },
        ],
      },
    },
  },
};

test("sends a persisted query and maps products", async () => {
  const seen: URL[] = [];
  const client = new HttpSKaupatClient({ productSearchHash: "abc", fetchImpl: fakeFetch(productResponse, 200, seen) });
  const res = await client.searchProducts({ storeId: "513971200", query: "maito", limit: 5 });
  assert.equal(seen[0]?.searchParams.get("operationName"), "RemoteFilteredProducts");
  assert.equal(JSON.parse(seen[0]!.searchParams.get("extensions")!).persistedQuery.sha256Hash, "abc");
  assert.equal(res.products[0]?.id, "0000000000017");
  assert.equal(res.products[0]?.priceBasis, "per_item");
  assert.equal(res.products[0]?.packSize, null);
  assert.equal(res.products[0]?.imageUrl, "https://img/w_300,h_300/x.jpg");
});

test("stale hash becomes unsupported", async () => {
  const client = new HttpSKaupatClient({
    productSearchHash: "old",
    fetchImpl: fakeFetch({ errors: [{ message: "x", extensions: { code: "PERSISTED_QUERY_NOT_FOUND" } }] }),
  });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "unsupported");
});

test("HTTP 403 becomes blocked", async () => {
  const client = new HttpSKaupatClient({ productSearchHash: "abc", fetchImpl: fakeFetch({}, 403) });
  await assert.rejects(client.searchProducts({ storeId: "1", query: "a", limit: 1 }), (e: SKaupatError) => e.code === "blocked");
});

test("get_products marks a search miss as unknown, not gone", async () => {
  const client = new HttpSKaupatClient({ productSearchHash: "abc", fetchImpl: fakeFetch(productResponse) });
  const res = await client.getProducts({ storeId: "1", ids: ["0000000000017", "999"] });
  assert.deepEqual(res.results.map((r) => r.status), ["found", "unknown"]);
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
