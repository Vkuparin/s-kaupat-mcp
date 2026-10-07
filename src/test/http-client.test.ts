import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpSKaupatClient } from "../client/http-client.js";
import { SKaupatError } from "../errors.js";

function fakeFetch(body: unknown, status = 200, seen: URL[] = []): typeof fetch {
  return (async (url: URL) => {
    seen.push(url);
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

test("store search finds store-like objects", async () => {
  const client = new HttpSKaupatClient({
    storeSearchHash: "s",
    fetchImpl: fakeFetch({
      data: { searchStores: { stores: [{ id: "1", name: "Prisma X", brand: "PRISMA", location: { address: { postcode: "00100", postcodeName: { default: "Helsinki" } } } }] } },
    }),
  });
  const stores = await client.searchStores({ query: "x", limit: 5 });
  assert.equal(stores[0]?.city, "Helsinki");
});
