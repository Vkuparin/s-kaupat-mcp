import { z } from "zod";
import { SKaupatError } from "../errors.js";
import { log } from "../log.js";
import type {
  GetProductsInput,
  Product,
  ProductLookup,
  ProductSearchResult,
  ProductsResult,
  SearchProductsInput,
  SearchStoresInput,
  SKaupatClient,
  Store,
} from "./types.js";

/**
 * Direct HTTP client for S-kaupat's public catalogue API.
 *
 * S-kaupat's web app talks to a GraphQL API using persisted queries: each
 * request sends an operation name plus the SHA-256 hash of a query the server
 * already knows. Hashes change when S-kaupat deploys, so they are supplied by
 * configuration for now. Whether this route is reliable enough, or whether a
 * managed browser session is needed, is the S0 feasibility decision in
 * docs/s-kaupat-mcp-plan.md. Response parsing below is UNVERIFIED against live
 * traffic and must be checked against sanitized fixtures before release.
 */

export interface HttpClientOptions {
  apiUrl?: string;
  origin?: string;
  timeoutMs?: number;
  /** Persisted query hash for the product search operation. */
  productSearchHash?: string;
  /** Persisted query hash for the store search operation. */
  storeSearchHash?: string;
  fetchImpl?: typeof fetch;
}

const OPERATIONS = {
  productSearch: "RemoteFilteredProducts",
  storeSearch: "RemoteStoreSearch",
} as const;

const PricingSchema = z
  .object({
    currentPrice: z.number().nullish(),
    regularPrice: z.number().nullish(),
    campaignPrice: z.number().nullish(),
    comparisonPrice: z.number().nullish(),
    comparisonUnit: z.string().nullish(),
  })
  .passthrough();

const ApiProductSchema = z
  .object({
    ean: z.string(),
    name: z.string(),
    price: z.number().nullish(),
    brandName: z.string().nullish(),
    priceUnit: z.string().nullish(),
    approxPrice: z.boolean().nullish(),
    pricing: PricingSchema.nullish(),
    hierarchyPath: z.array(z.object({ name: z.string() }).passthrough()).nullish(),
    productDetails: z
      .object({
        productImages: z
          .object({ mainImage: z.object({ urlTemplate: z.string() }).passthrough().nullish() })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const ProductSearchResponseSchema = z.object({
  data: z.object({
    store: z
      .object({
        products: z.object({
          total: z.number().nullish(),
          productListItems: z.array(z.object({ product: ApiProductSchema }).passthrough()),
        }),
      })
      .nullable(),
  }),
});

const GraphQLErrorsSchema = z.object({
  errors: z.array(
    z
      .object({
        message: z.string().optional(),
        extensions: z.object({ code: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  ),
});

export class HttpSKaupatClient implements SKaupatClient {
  private readonly apiUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions = {}) {
    this.apiUrl = options.apiUrl ?? "https://api.s-kaupat.fi/";
    this.origin = options.origin ?? "https://www.s-kaupat.fi";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchStores({ query, limit }: SearchStoresInput): Promise<Store[]> {
    const hash = this.requireHash(this.options.storeSearchHash, "SKAUPAT_STORE_SEARCH_HASH", OPERATIONS.storeSearch);
    const raw = await this.query(OPERATIONS.storeSearch, hash, { query, brand: null, cursor: null });
    return extractStores(raw).slice(0, limit);
  }

  async searchProducts({ storeId, query, limit }: SearchProductsInput): Promise<ProductSearchResult> {
    const hash = this.requireHash(
      this.options.productSearchHash,
      "SKAUPAT_PRODUCT_SEARCH_HASH",
      OPERATIONS.productSearch,
    );
    const raw = await this.query(OPERATIONS.productSearch, hash, {
      queryString: query,
      storeId,
      from: 0,
      limit,
    });
    const observedAt = new Date().toISOString();
    const parsed = ProductSearchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected product search response", { issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected product search response.");
    }
    const store = parsed.data.data.store;
    if (!store) {
      throw new SKaupatError("unavailable", `Store ${storeId} was not found.`, { storeId });
    }
    return {
      storeId,
      query,
      total: store.products.total ?? null,
      products: store.products.productListItems.map((item) => mapProduct(item.product, storeId, observedAt)),
      observedAt,
    };
  }

  /**
   * Refreshes exact product IDs. S-kaupat has no confirmed by-ID lookup in this
   * client yet, so each ID is searched for and matched exactly. A miss is
   * reported as "unknown", because search not matching an EAN does not prove
   * the product is gone.
   */
  async getProducts({ storeId, ids }: GetProductsInput): Promise<ProductsResult> {
    const results: ProductLookup[] = [];
    for (const id of ids) {
      const search = await this.searchProducts({ storeId, query: id, limit: 5 });
      const product = search.products.find((p) => p.id === id);
      results.push(
        product
          ? { id, status: "found", product }
          : { id, status: "unknown", reason: "Not returned by a search for this ID in this store." },
      );
    }
    return { storeId, results, observedAt: new Date().toISOString() };
  }

  private requireHash(hash: string | undefined, envName: string, operation: string): string {
    if (hash) return hash;
    throw new SKaupatError(
      "unsupported",
      `Live S-kaupat access is not configured: set ${envName} to the persisted query hash of ${operation}. ` +
        "See the README section 'Live mode'.",
    );
  }

  private async query(operationName: string, hash: string, variables: Record<string, unknown>): Promise<unknown> {
    const url = new URL(this.apiUrl);
    url.searchParams.set("operationName", operationName);
    url.searchParams.set("variables", JSON.stringify(variables));
    url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }));

    log.debug("GraphQL request", { operationName, variables });
    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Origin: this.origin,
        Referer: `${this.origin}/`,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (response.status === 403 || response.status === 429) {
      throw new SKaupatError("blocked", `S-kaupat refused the request (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new SKaupatError("upstream_error", `S-kaupat API returned HTTP ${response.status}.`);
    }

    const body: unknown = await response.json();
    const errors = GraphQLErrorsSchema.safeParse(body);
    if (errors.success && errors.data.errors.length > 0) {
      const first = errors.data.errors[0];
      if (first?.extensions?.code === "PERSISTED_QUERY_NOT_FOUND") {
        throw new SKaupatError(
          "unsupported",
          `The configured hash for ${operationName} is no longer accepted by S-kaupat; capture a fresh one.`,
        );
      }
      // Partial data with errors is still usable; fall through when data exists.
      if (!(body as { data?: unknown }).data) {
        throw new SKaupatError("upstream_error", first?.message ?? "S-kaupat returned a GraphQL error.");
      }
    }
    return body;
  }
}

function mapProduct(p: z.infer<typeof ApiProductSchema>, storeId: string, observedAt: string): Product {
  const pricing = p.pricing;
  const unit = p.priceUnit?.toUpperCase() ?? null;
  const priceBasis = unit === "KPL" ? "per_item" : unit === "KG" ? "per_weight" : "unknown";
  const imageTemplate = p.productDetails?.productImages?.mainImage?.urlTemplate;
  return {
    id: p.ean,
    storeId,
    name: p.name,
    brand: p.brandName ?? null,
    price: pricing?.currentPrice ?? p.price ?? null,
    campaignPrice: pricing?.campaignPrice ?? null,
    priceBasis,
    comparisonPrice: pricing?.comparisonPrice ?? null,
    comparisonUnit: pricing?.comparisonUnit ?? null,
    packSize: null,
    quantityUnit: unit,
    availability: "unknown",
    category: p.hierarchyPath?.[0]?.name ?? null,
    imageUrl: imageTemplate
      ? imageTemplate.replace("{MODIFIERS}", "w_300,h_300").replace("{EXTENSION}", "jpg")
      : null,
    observedAt,
  };
}

const ApiStoreSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullish(),
    location: z
      .object({
        address: z
          .object({
            street: z.object({ default: z.string().nullish() }).passthrough().nullish(),
            postcode: z.string().nullish(),
            postcodeName: z.object({ default: z.string().nullish() }).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

/**
 * The store search response is expected at data.searchStores.stores (see
 * docs/s-kaupat-api.md) but has not been captured live yet, so this looks for
 * the first array of store-like objects anywhere in `data`. Replace with an
 * exact schema once a sanitized fixture exists.
 */
function extractStores(raw: unknown): Store[] {
  const data = (raw as { data?: unknown })?.data;
  const queue: unknown[] = [data];
  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      const parsed = node.map((item) => ApiStoreSchema.safeParse(item));
      if (parsed.length > 0 && parsed.every((r) => r.success)) {
        return parsed.map((r) => mapStore(r.data!));
      }
      queue.push(...node);
    } else if (node && typeof node === "object") {
      queue.push(...Object.values(node));
    }
  }
  throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected store search response.");
}

function mapStore(s: z.infer<typeof ApiStoreSchema>): Store {
  const address = s.location?.address;
  return {
    id: s.id,
    name: s.name,
    brand: s.brand ?? null,
    street: address?.street?.default ?? null,
    postalCode: address?.postcode ?? null,
    city: address?.postcodeName?.default ?? null,
    fulfillmentModes: null,
  };
}
