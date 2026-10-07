import { z } from "zod";
import { isProductUnavailableError, SKaupatError, storeNotFound } from "../errors.js";
import { log } from "../log.js";
import { chainCode, chainName, toOpeningDay } from "../stores.js";
import type { ListItemInput, ShoppingList, ShoppingListApi, ShoppingListItem } from "../lists/types.js";
import type {
  Allergen,
  AllergenLevel,
  BasketCheck,
  BrowseCategoryInput,
  Category,
  CategoryProductsResult,
  GetProductsInput,
  ListableProduct,
  Product,
  ProductDetails,
  ProductLookup,
  ProductSearchResult,
  ProductSort,
  ProductsResult,
  SearchProductsInput,
  SearchStoresInput,
  SKaupatClient,
  Store,
  StoreDetails,
  StoreSearchResult,
} from "./types.js";

/**
 * Direct HTTP client for S-kaupat's public catalogue API.
 *
 * The API accepts this client's own GraphQL query text without login (live-
 * verified 2026-10-07, see docs/s-kaupat-api.md), so every call sends its own
 * query and no persisted-query hashes are needed. Response shapes follow the
 * captured samples in docs/samples.
 */

export interface HttpClientOptions {
  apiUrl?: string;
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** searchStores returns 24 stores per page. Cap paging so one call stays a few requests. */
const STORE_PAGE_SIZE = 24;
const MAX_STORE_PAGES = 3;

const STORE_SEARCH_QUERY = `query RemoteStoreSearch($query: String, $brand: StoreBrand, $cursor: String) {
  searchStores(query: $query, brand: $brand, cursor: $cursor) {
    totalCount cursor
    stores { id name brand domains
      location { address { street { default } postcode postcodeName { default } } coordinates { lat lon } } }
  }
}`;

const STORE_DETAIL_FIELDS = "id name brand weeklyOpeningHours { openingTimes { date day mode ranges { open close } } }";

/** Product fields shared by search, category browsing and lookups by EAN (all seen in docs/samples). */
const PRODUCT_FIELDS =
  "id ean name price brandName approxPrice priceUnit isAgeLimitedByAlcohol frozen packagingLabels " +
  "availability { label date } location { aisle shelf } hierarchyPath { id name slug } " +
  "pricing { currentPrice regularPrice campaignPrice campaignPriceValidUntil lowest30DayPrice comparisonPrice " +
  "comparisonUnit depositPrice isApproximatePrice } " +
  "productDetails { productImages { mainImage { urlTemplate } } }";

const PRODUCT_LIST_QUERY = `query RemoteFilteredProducts($storeId: ID!, $queryString: String, $from: Int, $limit: Int, $orderBy: SortKey, $order: SortOrder) {
  store(id: $storeId) { id
    products(queryString: $queryString, from: $from, limit: $limit, orderBy: $orderBy, order: $order) {
      total productListItems { product { ${PRODUCT_FIELDS} } }
    }
  }
}`;

const CATEGORY_PRODUCTS_QUERY = `query RemoteFilteredProducts($storeId: ID!, $slug: String, $from: Int, $limit: Int, $orderBy: SortKey, $order: SortOrder) {
  store(id: $storeId) { id
    products(slug: $slug, from: $from, limit: $limit, orderBy: $orderBy, order: $order) {
      total productListItems { product { ${PRODUCT_FIELDS} } }
    }
  }
}`;

/** Product page fields on top of PRODUCT_FIELDS (all seen in docs/samples/product-detail.json and category-browse.json). */
const PRODUCT_DETAIL_QUERY = `query RemoteProductInfo($id: ID!, $storeId: ID!) {
  product(id: $id, storeId: $storeId) { ${PRODUCT_FIELDS}
    description ingredientStatement supplierName countryName { fi }
    nutrients { name value ri kcal } allergens { allergenTypeCode allergenTypeText levelOfContainmentCode }
    measurement { netWeight }
  }
}`;

const NAVIGATION_QUERY = `query RemoteNavigation($id: ID!) {
  store(id: $id) { id navigation { id name slug children { id name slug children { id name slug } } } }
}`;

/** The category tree is about 160 KB per store and changes rarely. */
const CATEGORY_CACHE_MS = 6 * 60 * 60_000;

const PRODUCTS_BY_EAN_QUERY = `query RemoteProductsByEans($storeId: ID!, $eans: [String!]) {
  store(id: $storeId) { id
    products(eans: $eans) { total productListItems { product { ${PRODUCT_FIELDS} } } }
  }
}`;

/** Same lookup through ProductList.items, which also exposes the per-store sokId (docs/samples/availability-with-date.json). */
const LISTABLE_PRODUCTS_QUERY = `query RemoteListableProducts($storeId: ID!, $eans: [String!]) {
  store(id: $storeId) { id
    products(eans: $eans) { items { ${PRODUCT_FIELDS} store(storeId: $storeId) { sokId } } }
  }
}`;

const CHECK_BASKET_QUERY = `query RemoteCheckBasket($items: [PartialCartItemInput!]!, $storeId: ID!) {
  validateCart(partialCartItems: $items, storeId: $storeId) {
    cartValidationItems { ean labels { labelText } validationError { __typename
      ... on ProductAvailabilityError { labelText } } }
  }
}`;

/** One shopping list with each item's product priced in $storeId. Items are a union in S-kaupat's schema. */
const LIST_FIELDS =
  "id name createdAt items { ... on ShoppingListItem { id ean sokId quantity isReplaceable name " +
  `product(storeId: $storeId) { ${PRODUCT_FIELDS} } } }`;

const LIST_QUERIES = {
  getLists: `query RemoteGetUserLists($storeId: ID!) { shoppingLists { ${LIST_FIELDS} } }`,
  getList: `query RemoteGetUserListById($id: ID!, $storeId: ID!) { shoppingList(id: $id) { ${LIST_FIELDS} } }`,
  createList: `mutation RemoteCreateUserList($name: String!, $storeId: ID!) { createShoppingList(name: $name) { ${LIST_FIELDS} } }`,
  addItem: `mutation RemoteAddToShoppingList($storeId: ID!, $shoppingListId: ID!, $item: ShoppingListItemInput!) {
    createShoppingListItem(shoppingListId: $shoppingListId, item: $item) { ${LIST_FIELDS} } }`,
  removeItem: `mutation RemoteRemoveShoppingListItem($storeId: ID!, $shoppingListId: ID!, $itemId: ID!) {
    deleteShoppingListItem(shoppingListId: $shoppingListId, itemId: $itemId) { ${LIST_FIELDS} } }`,
  deleteList: "mutation RemoteRemoveUserList($id: ID!) { deleteShoppingList(id: $id) { id } }",
} as const;

/** GraphQL error codes that mean the access token was not accepted. */
const AUTH_ERROR_CODES = ["UNAUTHENTICATED", "UNAUTHORIZED", "FORBIDDEN"];

const SORTS: Record<ProductSort, { orderBy?: string; order?: string }> = {
  relevance: {},
  price_asc: { orderBy: "price", order: "asc" },
  price_desc: { orderBy: "price", order: "desc" },
};

const PricingSchema = z
  .object({
    currentPrice: z.number().nullish(),
    regularPrice: z.number().nullish(),
    campaignPrice: z.number().nullish(),
    campaignPriceValidUntil: z.string().nullish(),
    lowest30DayPrice: z.number().nullish(),
    comparisonPrice: z.number().nullish(),
    comparisonUnit: z.string().nullish(),
    depositPrice: z.number().nullish(),
    isApproximatePrice: z.boolean().nullish(),
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
    isAgeLimitedByAlcohol: z.boolean().nullish(),
    frozen: z.boolean().nullish(),
    packagingLabels: z.array(z.string()).nullish(),
    location: z
      .object({ aisle: z.coerce.string().nullish(), shelf: z.coerce.string().nullish() })
      .passthrough()
      .nullish(),
    pricing: PricingSchema.nullish(),
    hierarchyPath: z.array(z.object({ name: z.string(), slug: z.string().nullish() }).passthrough()).nullish(),
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

const ProductListResponseSchema = z.object({
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

export class HttpSKaupatClient implements SKaupatClient, ShoppingListApi {
  private readonly apiUrl: string;
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly categoryCache = new Map<string, { categories: Category[]; until: number }>();

  constructor(private readonly options: HttpClientOptions = {}) {
    this.apiUrl = options.apiUrl ?? "https://api.s-kaupat.fi/";
    this.origin = options.origin ?? "https://www.s-kaupat.fi";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchStores({ query, chain, limit }: SearchStoresInput): Promise<StoreSearchResult> {
    const stores: Store[] = [];
    let total: number | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_STORE_PAGES && stores.length < limit; page++) {
      const raw = await this.post("RemoteStoreSearch", STORE_SEARCH_QUERY, {
        query: query ?? null,
        brand: chain ?? null,
        cursor,
      });
      const parsed = StoreSearchResponseSchema.safeParse(raw);
      if (!parsed.success) {
        log.warn("Unexpected store search response", { issues: parsed.error.issues.slice(0, 3) });
        throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected store search response.");
      }
      const result = parsed.data.data.searchStores;
      total = result.totalCount ?? total;
      stores.push(...result.stores.map(mapStore));
      cursor = result.cursor ?? null;
      if (!cursor || result.stores.length < STORE_PAGE_SIZE) break;
    }
    return { total, stores: stores.slice(0, limit) };
  }

  /** Fetches several stores in one request using GraphQL aliases (s0, s1, …). */
  async getStores(ids: string[]): Promise<Map<string, StoreDetails>> {
    const unique = [...new Set(ids)];
    const found = new Map<string, StoreDetails>();
    if (unique.length === 0) return found;
    const params = unique.map((_, i) => `$s${i}: ID!`).join(", ");
    const fields = unique.map((_, i) => `s${i}: store(id: $s${i}) { ${STORE_DETAIL_FIELDS} }`).join(" ");
    const variables = Object.fromEntries(unique.map((id, i) => [`s${i}`, id]));
    const raw = await this.post("RemoteStores", `query RemoteStores(${params}) { ${fields} }`, variables);
    const data = (raw as { data?: Record<string, unknown> | null }).data ?? {};
    unique.forEach((id, i) => {
      const parsed = ApiStoreDetailSchema.nullish().safeParse(data[`s${i}`]);
      if (!parsed.success) {
        log.warn("Unexpected store response", { storeId: id, issues: parsed.error.issues.slice(0, 3) });
        return;
      }
      const s = parsed.data;
      if (!s) return;
      found.set(id, {
        id: s.id,
        name: s.name,
        chain: chainCode(s.brand),
        openingHours: (s.weeklyOpeningHours ?? []).flatMap((w) => w.openingTimes.map(toOpeningDay)),
      });
    });
    return found;
  }

  async searchProducts({ storeId, query, limit, offset = 0, sort = "relevance" }: SearchProductsInput): Promise<ProductSearchResult> {
    const { products, total, observedAt } = await this.listProducts(storeId, "RemoteFilteredProducts", PRODUCT_LIST_QUERY, {
      queryString: query,
      from: offset,
      limit,
      ...SORTS[sort],
    });
    return { storeId, query, total, offset, sort, products, observedAt };
  }

  /**
   * Looks up exact EANs in one request. An EAN the store does not return is
   * not_found: either the barcode is unknown or the store does not sell it.
   */
  async getProducts({ storeId, ids }: GetProductsInput): Promise<ProductsResult> {
    const { products, observedAt } = await this.listProducts(storeId, "RemoteProductsByEans", PRODUCTS_BY_EAN_QUERY, {
      eans: ids,
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const results: ProductLookup[] = ids.map((id) => {
      const product = byId.get(id);
      return product
        ? { id, status: "found", product }
        : { id, status: "not_found", reason: "Not sold in this store, or not a known barcode." };
    });
    return { storeId, results, observedAt };
  }

  async getProductDetails(storeId: string, id: string): Promise<ProductDetails | null> {
    const raw = await this.post("RemoteProductInfo", PRODUCT_DETAIL_QUERY, { id, storeId });
    const parsed = ProductDetailResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected product detail response", { issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected product response.");
    }
    const p = parsed.data.data.product;
    return p ? mapProductDetails(p, storeId, new Date().toISOString()) : null;
  }

  async getCategories(storeId: string): Promise<Category[]> {
    const cached = this.categoryCache.get(storeId);
    if (cached && cached.until > Date.now()) return cached.categories;
    const raw = await this.post("RemoteNavigation", NAVIGATION_QUERY, { id: storeId });
    const parsed = NavigationResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected category response", { issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected category response.");
    }
    const store = parsed.data.data.store;
    if (!store) throw storeNotFound(storeId);
    const categories = (store.navigation ?? []).map(mapCategory);
    this.categoryCache.set(storeId, { categories, until: Date.now() + CATEGORY_CACHE_MS });
    return categories;
  }

  async browseCategory({ storeId, slug, limit, offset = 0, sort = "relevance" }: BrowseCategoryInput): Promise<CategoryProductsResult> {
    const { products, total, observedAt } = await this.listProducts(storeId, "RemoteFilteredProducts", CATEGORY_PRODUCTS_QUERY, {
      slug,
      from: offset,
      limit,
      ...SORTS[sort],
    });
    return { storeId, slug, total, offset, sort, products, observedAt };
  }

  async getListableProducts(storeId: string, ids: string[]): Promise<Map<string, ListableProduct>> {
    const raw = await this.post("RemoteListableProducts", LISTABLE_PRODUCTS_QUERY, { storeId, eans: ids });
    const parsed = ListableProductsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected listable products response", { issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected product response.");
    }
    const store = parsed.data.data.store;
    if (!store) throw storeNotFound(storeId);
    const observedAt = new Date().toISOString();
    const found = new Map<string, ListableProduct>();
    for (const p of store.products.items) {
      found.set(p.ean, { product: mapProduct(p, storeId, observedAt), sokId: p.store?.sokId ?? null });
    }
    return found;
  }

  async checkBasket(storeId: string, items: { id: string; quantity: number }[]): Promise<Map<string, BasketCheck>> {
    const raw = await this.post("RemoteCheckBasket", CHECK_BASKET_QUERY, {
      storeId,
      // PartialCartItemInput.itemCount is a string.
      items: items.map((i) => ({ ean: i.id, itemCount: String(i.quantity) })),
    });
    const parsed = CheckBasketResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected cart check response", { issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected cart check response.");
    }
    const checks = new Map<string, BasketCheck>();
    for (const item of parsed.data.data.validateCart.cartValidationItems) {
      const error = item.validationError;
      const status: BasketCheck["status"] = !error
        ? "ok"
        : error.__typename === "ProductNotFoundError"
          ? "not_found"
          : error.__typename === "ProductNotInAssortmentError"
            ? "not_in_store"
            : "unavailable";
      checks.set(item.ean, {
        id: item.ean,
        status,
        label: error?.labelText ?? item.labels?.find((l) => l.labelText)?.labelText ?? null,
      });
    }
    return checks;
  }

  // Shopping lists (need a login).

  async getLists(accessToken: string, storeId: string): Promise<ShoppingList[]> {
    const data = await this.listCall("RemoteGetUserLists", LIST_QUERIES.getLists, { storeId }, accessToken);
    return z.array(ApiListSchema).parse(data.shoppingLists ?? []).map((l) => mapList(l, storeId));
  }

  async getList(accessToken: string, listId: string, storeId: string): Promise<ShoppingList | null> {
    const data = await this.listCall("RemoteGetUserListById", LIST_QUERIES.getList, { id: listId, storeId }, accessToken);
    const list = ApiListSchema.nullish().parse(data.shoppingList);
    return list ? mapList(list, storeId) : null;
  }

  async createList(accessToken: string, name: string, storeId: string): Promise<ShoppingList> {
    const data = await this.listCall("RemoteCreateUserList", LIST_QUERIES.createList, { name, storeId }, accessToken);
    return mapList(ApiListSchema.parse(data.createShoppingList), storeId);
  }

  async addItem(accessToken: string, listId: string, item: ListItemInput, storeId: string): Promise<ShoppingList> {
    const data = await this.listCall(
      "RemoteAddToShoppingList",
      LIST_QUERIES.addItem,
      { storeId, shoppingListId: listId, item },
      accessToken,
    );
    return mapList(ApiListSchema.parse(data.createShoppingListItem), storeId);
  }

  async removeItem(accessToken: string, listId: string, itemId: string, storeId: string): Promise<ShoppingList> {
    const data = await this.listCall(
      "RemoteRemoveShoppingListItem",
      LIST_QUERIES.removeItem,
      { storeId, shoppingListId: listId, itemId },
      accessToken,
    );
    return mapList(ApiListSchema.parse(data.deleteShoppingListItem), storeId);
  }

  async deleteList(accessToken: string, listId: string): Promise<void> {
    await this.listCall("RemoteRemoveUserList", LIST_QUERIES.deleteList, { id: listId }, accessToken);
  }

  /** An authenticated list call; returns `data`. A response that does not match the schema throws, which tools report as upstream_error. */
  private async listCall(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const raw = (await this.post(operationName, query, variables, accessToken)) as { data?: Record<string, unknown> | null };
    return raw.data ?? {};
  }

  private async listProducts(
    storeId: string,
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{ products: Product[]; total: number | null; observedAt: string }> {
    const raw = await this.post(operationName, query, { storeId, ...variables });
    const observedAt = new Date().toISOString();
    const parsed = ProductListResponseSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn("Unexpected product list response", { operationName, issues: parsed.error.issues.slice(0, 3) });
      throw new SKaupatError("upstream_error", "S-kaupat returned an unexpected product response.");
    }
    const store = parsed.data.data.store;
    if (!store) throw storeNotFound(storeId);
    return {
      products: store.products.productListItems.map((item) => mapProduct(item.product, storeId, observedAt)),
      total: store.products.total ?? null,
      observedAt,
    };
  }

  /** POST with this client's own query text. The access token, when given, is never logged. */
  private async post(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
    accessToken?: string,
  ): Promise<unknown> {
    log.debug("GraphQL request", { operationName, variables, authenticated: Boolean(accessToken) });
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: this.origin,
      Referer: `${this.origin}/`,
    };
    // The site sends the raw JWT, with no "Bearer" prefix.
    if (accessToken) headers.authorization = accessToken;
    return this.send(operationName, new URL(this.apiUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ operationName, query, variables }),
    });
  }

  private async send(operationName: string, url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    const authenticated = Boolean((init.headers as Record<string, string> | undefined)?.authorization);

    if (authenticated && response.status === 401) {
      throw new SKaupatError("session_expired", "S-kaupat answered HTTP 401 to an authenticated call.");
    }
    if (response.status === 403 || response.status === 429) {
      throw new SKaupatError("blocked", `S-kaupat refused the request (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      // A rejected query (HTTP 400) means S-kaupat changed its API; the body names the field.
      if (response.status === 400) log.warn("S-kaupat rejected a query", { operationName, body: await safeText(response) });
      throw new SKaupatError("upstream_error", `S-kaupat API returned HTTP ${response.status}.`);
    }

    const body: unknown = await response.json();
    const errors = GraphQLErrorsSchema.safeParse(body);
    if (errors.success && errors.data.errors.length > 0) {
      const first = errors.data.errors[0];
      if (authenticated && errors.data.errors.some((e) => AUTH_ERROR_CODES.includes(e.extensions?.code ?? ""))) {
        throw new SKaupatError("session_expired", `S-kaupat did not accept the login for ${operationName}.`);
      }
      const productError = errors.data.errors.find(isProductUnavailableError);
      if (productError) {
        throw new SKaupatError("product_unavailable", productError.message ?? "Product is not available.");
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
  // hierarchyPath is ordered leaf first.
  const leaf = p.hierarchyPath?.[0];
  return {
    id: p.ean,
    storeId,
    name: p.name,
    brand: p.brandName ?? null,
    price: pricing?.currentPrice ?? p.price ?? null,
    regularPrice: pricing?.regularPrice ?? null,
    campaignPrice: pricing?.campaignPrice ?? null,
    campaignValidUntil: pricing?.campaignPriceValidUntil ?? null,
    lowest30DayPrice: pricing?.lowest30DayPrice ?? null,
    depositPrice: pricing?.depositPrice || null,
    priceBasis,
    approximatePrice: pricing?.isApproximatePrice ?? p.approxPrice ?? null,
    comparisonPrice: pricing?.comparisonPrice ?? null,
    comparisonUnit: pricing?.comparisonUnit ?? null,
    packSize: null,
    quantityUnit: unit,
    // availability is null for ordinary in-stock products; what a label means is not mapped yet.
    availability: "unknown",
    category: leaf?.name ?? null,
    categorySlug: leaf?.slug ?? null,
    labels: p.packagingLabels ?? [],
    ageLimited: p.isAgeLimitedByAlcohol ?? null,
    frozen: p.frozen ?? null,
    shelfLocation: p.location ? { aisle: p.location.aisle ?? null, shelf: p.location.shelf ?? null } : null,
    imageUrl: imageTemplate
      ? imageTemplate.replace("{MODIFIERS}", "w_300,h_300").replace("{EXTENSION}", "jpg")
      : null,
    observedAt,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}

const ApiStoreSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullish(),
    domains: z.array(z.string()).nullish(),
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
        // S-kaupat sends coordinates as strings, e.g. "61.492234".
        coordinates: z.object({ lat: z.coerce.number(), lon: z.coerce.number() }).passthrough().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const StoreSearchResponseSchema = z.object({
  data: z.object({
    searchStores: z.object({
      totalCount: z.number().nullish(),
      cursor: z.string().nullish(),
      stores: z.array(ApiStoreSchema),
    }),
  }),
});

const ApiStoreDetailSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullish(),
    weeklyOpeningHours: z
      .array(
        z.object({
          openingTimes: z.array(
            z.object({
              date: z.string(),
              day: z.string(),
              mode: z.string().nullish(),
              ranges: z.array(z.object({ open: z.string(), close: z.string() })).nullish(),
            }),
          ),
        }),
      )
      .nullish(),
  })
  .passthrough();

function mapStore(s: z.infer<typeof ApiStoreSchema>): Store {
  const address = s.location?.address;
  const coords = s.location?.coordinates;
  const chain = chainCode(s.brand);
  return {
    id: s.id,
    name: s.name,
    chain,
    chainName: chainName(chain),
    street: address?.street?.default ?? null,
    postalCode: address?.postcode ?? null,
    city: address?.postcodeName?.default ?? null,
    coordinates:
      coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon) ? { lat: coords.lat, lon: coords.lon } : null,
    // domains is ["S_KAUPAT"] for some stores and [] for others; most likely online ordering (unconfirmed).
    onlineOrdering: s.domains ? s.domains.includes("S_KAUPAT") : null,
  };
}

const ListableProductsResponseSchema = z.object({
  data: z.object({
    store: z
      .object({
        products: z.object({
          items: z.array(
            ApiProductSchema.extend({ store: z.object({ sokId: z.string().nullish() }).passthrough().nullish() }),
          ),
        }),
      })
      .nullable(),
  }),
});

const CheckBasketResponseSchema = z.object({
  data: z.object({
    validateCart: z.object({
      cartValidationItems: z.array(
        z
          .object({
            ean: z.string(),
            labels: z.array(z.object({ labelText: z.string().nullish() }).passthrough()).nullish(),
            validationError: z
              .object({ __typename: z.string(), labelText: z.string().nullish() })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      ),
    }),
  }),
});

const ApiListItemSchema = z
  .object({
    id: z.string(),
    ean: z.string(),
    name: z.string().nullish(),
    quantity: z.number().nullish(),
    isReplaceable: z.boolean().nullish(),
    product: ApiProductSchema.nullish(),
  })
  .passthrough();

const ApiListSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string().nullish(),
    // Items are a union; members other than ShoppingListItem come back as {} and are skipped.
    items: z.array(z.union([ApiListItemSchema, z.object({}).passthrough()])).nullish(),
  })
  .passthrough();

function mapList(l: z.infer<typeof ApiListSchema>, storeId: string): ShoppingList {
  const observedAt = new Date().toISOString();
  const items: ShoppingListItem[] = [];
  for (const raw of l.items ?? []) {
    const item = ApiListItemSchema.safeParse(raw);
    if (!item.success) continue;
    const i = item.data;
    items.push({
      itemId: i.id,
      productId: i.ean,
      name: i.name ?? i.product?.name ?? i.ean,
      quantity: i.quantity ?? 1,
      allowSubstitutes: i.isReplaceable ?? false,
      product: i.product ? mapProduct(i.product, storeId, observedAt) : null,
    });
  }
  return { id: l.id, name: l.name, createdAt: l.createdAt ?? null, storeId, items };
}

const ApiProductDetailSchema = ApiProductSchema.extend({
  description: z.string().nullish(),
  ingredientStatement: z.string().nullish(),
  supplierName: z.string().nullish(),
  countryName: z.object({ fi: z.string().nullish() }).passthrough().nullish(),
  nutrients: z
    .array(
      z
        .object({ name: z.string(), value: z.string().nullish(), ri: z.string().nullish(), kcal: z.number().nullish() })
        .passthrough(),
    )
    .nullish(),
  allergens: z
    .array(
      z
        .object({
          allergenTypeCode: z.string(),
          allergenTypeText: z.string().nullish(),
          levelOfContainmentCode: z.string().nullish(),
        })
        .passthrough(),
    )
    .nullish(),
  measurement: z.object({ netWeight: z.number().nullish() }).passthrough().nullish(),
});

const ProductDetailResponseSchema = z.object({ data: z.object({ product: ApiProductDetailSchema.nullable() }) });

interface ApiCategory {
  id: string;
  name: string;
  slug: string;
  children?: ApiCategory[] | null;
}

const ApiCategorySchema: z.ZodType<ApiCategory> = z.lazy(() =>
  z.object({ id: z.string(), name: z.string(), slug: z.string(), children: z.array(ApiCategorySchema).nullish() }),
);

const NavigationResponseSchema = z.object({
  data: z.object({ store: z.object({ navigation: z.array(ApiCategorySchema).nullish() }).passthrough().nullable() }),
});

function mapCategory(c: ApiCategory): Category {
  return { id: c.id, name: c.name, slug: c.slug, children: (c.children ?? []).map(mapCategory) };
}

/** GS1 levelOfContainment codes; only CONTAINS has been seen live. */
const ALLERGEN_LEVELS: Record<string, AllergenLevel> = {
  CONTAINS: "contains",
  MAY_CONTAIN: "may_contain",
  FREE_FROM: "free_from",
};

function mapProductDetails(p: z.infer<typeof ApiProductDetailSchema>, storeId: string, observedAt: string): ProductDetails {
  return {
    ...mapProduct(p, storeId, observedAt),
    description: p.description ?? null,
    ingredients: p.ingredientStatement ?? null,
    allergens: (p.allergens ?? []).map(
      (a): Allergen => ({
        code: a.allergenTypeCode,
        name: a.allergenTypeText ?? null,
        level: ALLERGEN_LEVELS[a.levelOfContainmentCode?.toUpperCase() ?? ""] ?? "unknown",
      }),
    ),
    nutrients: (p.nutrients ?? []).map((n) => ({
      name: n.name,
      value: n.value ?? null,
      referenceIntake: n.ri ?? null,
      kcal: n.kcal ?? null,
    })),
    countryOfOrigin: p.countryName?.fi ?? null,
    supplier: p.supplierName ?? null,
    netWeightKg: p.measurement?.netWeight ?? null,
  };
}
