/**
 * Domain types for the S-kaupat client. These are this project's own shapes,
 * not S-kaupat's API shapes; adapters translate into them.
 *
 * Rule from the plan: unknown fields stay unknown (null), never guessed.
 */

/** Chain codes S-kaupat's store search accepts as a filter (StoreBrand enum). */
export const STORE_CHAINS = [
  "PRISMA",
  "EPRISMA",
  "S_MARKET",
  "SALE",
  "ALEPA",
  "ABC",
  "HERKKU",
  "SOKOS_HERKKU",
  "MESTARIN_HERKKU",
] as const;
export type StoreChain = (typeof STORE_CHAINS)[number];

export interface Store {
  /** Stable S-kaupat store (branch) ID, used as context for product calls. */
  id: string;
  /** Display name, e.g. "Prisma Kaleva Tampere". */
  name: string;
  /** Chain code, e.g. "PRISMA", "S_MARKET", "ALEPA", when known. */
  chain: string | null;
  /** Chain display name, e.g. "Prisma", "S-market", when known. */
  chainName: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  /** Coordinates when known, so an app can sort or map stores by distance. */
  coordinates: { lat: number; lon: number } | null;
  /** Whether the store takes online grocery orders on S-kaupat. Null = unknown. */
  onlineOrdering: boolean | null;
}

export type OpeningStatus = "open" | "open_24h" | "closed" | "unknown";

export interface OpeningDay {
  /** Local date in Finland, YYYY-MM-DD. */
  date: string;
  /** MON … SUN. */
  day: string;
  status: OpeningStatus;
  /** Opening ranges as local times, e.g. { open: "06:00", close: "00:00" }. Empty unless status is "open". */
  ranges: { open: string; close: string }[];
}

/** Store details that come from a per-store lookup rather than search. */
export interface StoreDetails {
  id: string;
  name: string;
  chain: string | null;
  /** The store with its address, when S-kaupat sent it. */
  store?: Store;
  /** Upcoming days as S-kaupat reports them (about three weeks), oldest first. */
  openingHours: OpeningDay[];
}

export interface StoreSearchResult {
  /** Total matching stores reported by S-kaupat, when known. */
  total: number | null;
  stores: Store[];
}

export type PriceBasis = "per_item" | "per_weight" | "unknown";

/** Product sort orders. "relevance" is S-kaupat's own search ranking. */
export const PRODUCT_SORTS = ["relevance", "price_asc", "price_desc"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export interface Product {
  /** Product ID as S-kaupat identifies it (the EAN barcode). */
  id: string;
  storeId: string;
  name: string;
  brand: string | null;
  /** Current shelf price in euros (the campaign price while a campaign runs). */
  price: number | null;
  /** Normal price in euros, when S-kaupat reports one. */
  regularPrice: number | null;
  /** Campaign price in euros, when one applies. */
  campaignPrice: number | null;
  /** Last day of the campaign price as S-kaupat reports it, when known. */
  campaignValidUntil: string | null;
  /** Lowest price in the last 30 days in euros, when S-kaupat reports one. */
  lowest30DayPrice: number | null;
  /** Bottle or can deposit in euros, when one applies. */
  depositPrice: number | null;
  priceBasis: PriceBasis;
  /** True when the price is an estimate, e.g. for weighed goods. Null = unknown. */
  approximatePrice: boolean | null;
  /** Comparison (unit) price in euros per comparisonUnit. */
  comparisonPrice: number | null;
  /** Unit for comparisonPrice as S-kaupat reports it, e.g. "LTR" (litre) or "KPL" (piece). */
  comparisonUnit: string | null;
  /** Pack size as shown by the store, e.g. "1 l", when known. */
  packSize: string | null;
  /** Native quantity unit used when adding to cart, when known. */
  quantityUnit: string | null;
  availability: "available" | "unavailable" | "unknown";
  /** Most specific category name, e.g. "Maidot". */
  category: string | null;
  /** Category path usable with browse_category, e.g. "maito-munat-ja-rasvat/maidot-ja-piimat/maidot". */
  categorySlug: string | null;
  /** Packaging and origin labels, e.g. "Hyvää Suomesta (Sininen Joutsen)". */
  labels: string[];
  /** Alcohol with an age limit. Null = unknown. */
  ageLimited: boolean | null;
  frozen: boolean | null;
  /** Where the product is in the physical store, when known. */
  shelfLocation: { aisle: string | null; shelf: string | null } | null;
  imageUrl: string | null;
  /** ISO timestamp of when this data was fetched. */
  observedAt: string;
}

export interface ProductSearchResult {
  storeId: string;
  query: string;
  /** Total matches reported by S-kaupat, when known. */
  total: number | null;
  /** Offset of the first returned product, for paging. */
  offset: number;
  sort: ProductSort;
  products: Product[];
  observedAt: string;
}

export type ProductLookup =
  | { id: string; status: "found"; product: Product }
  | { id: string; status: "not_found" | "unknown"; reason: string };

export interface ProductsResult {
  storeId: string;
  results: ProductLookup[];
  observedAt: string;
}

export interface SearchStoresInput {
  /** Free text: store name, city or postal code. Omit to list all stores. */
  query?: string;
  chain?: StoreChain;
  limit: number;
}

export interface SearchProductsInput {
  storeId: string;
  query: string;
  limit: number;
  /** Number of products to skip, for paging. Defaults to 0. */
  offset?: number;
  sort?: ProductSort;
}

export interface GetProductsInput {
  storeId: string;
  ids: string[];
}

export type AllergenLevel = "contains" | "may_contain" | "free_from" | "unknown";

export interface Allergen {
  /** S-kaupat's allergen code, e.g. "AM" (milk), "ML" (lactose). */
  code: string;
  /** Finnish name, e.g. "Maito". */
  name: string | null;
  level: AllergenLevel;
}

export interface Nutrient {
  /** Finnish name as S-kaupat gives it, e.g. "Energia", "- josta sokereita". */
  name: string;
  /** Amount per 100 g or 100 ml as S-kaupat formats it, e.g. "1,5 g", "196 kJ / 47 kcal". */
  value: string | null;
  /** Share of the reference intake, e.g. "2,14%", when given. */
  referenceIntake: string | null;
  /** Kilocalories, only on the energy row. */
  kcal: number | null;
}

/** Everything search returns plus the product page details. */
export interface ProductDetails extends Product {
  description: string | null;
  ingredients: string | null;
  allergens: Allergen[];
  /** Per 100 g or 100 ml, in the order S-kaupat lists them. */
  nutrients: Nutrient[];
  countryOfOrigin: string | null;
  supplier: string | null;
  /** Net weight in kilograms as S-kaupat reports it (a 1 l carton of milk reports 1.036). */
  netWeightKg: number | null;
}

export interface Category {
  id: string;
  /** Finnish name, e.g. "Maito, munat ja rasvat". */
  name: string;
  /** Full path, for browse_category, e.g. "maito-munat-ja-rasvat/maidot-ja-piimat". */
  slug: string;
  children: Category[];
}

export interface BrowseCategoryInput {
  storeId: string;
  slug: string;
  limit: number;
  offset?: number;
  sort?: ProductSort;
}

export interface CategoryProductsResult {
  storeId: string;
  slug: string;
  total: number | null;
  offset: number;
  sort: ProductSort;
  products: Product[];
  observedAt: string;
}

/** A product with the internal id S-kaupat needs to put it on a shopping list. */
export interface ListableProduct {
  product: Product;
  /** S Group's internal product id (sokId); null if S-kaupat did not report one. */
  sokId: string | null;
}

/**
 * Whether one product can be ordered from a store, from S-kaupat's own cart check.
 * - ok: no known problem.
 * - unavailable: sold here but not orderable right now (e.g. out of stock).
 * - not_in_store: a known product this store does not sell.
 * - not_found: S-kaupat does not know the barcode.
 * - unknown: the check returned nothing for this product.
 */
export type BasketCheckStatus = "ok" | "unavailable" | "not_in_store" | "not_found" | "unknown";

export interface BasketCheck {
  id: string;
  status: BasketCheckStatus;
  /** S-kaupat's own short label for the problem, in Finnish, when it gives one. */
  label: string | null;
}

/** The chosen delivery or pickup time, so the cart check answers for that day. */
export interface BasketDelivery {
  /** YYYY-MM-DD. */
  date: string;
  slotId: string;
  areaId: string;
}

/**
 * The reusable retailer client. The MCP layer depends only on this interface,
 * so the transport (direct HTTP, managed browser, extension) can change after
 * S0 without touching tool definitions.
 */
export interface SKaupatClient {
  searchStores(input: SearchStoresInput): Promise<StoreSearchResult>;
  /** Looks up stores by ID. Unknown IDs are missing from the returned map. */
  getStores(ids: string[]): Promise<Map<string, StoreDetails>>;
  searchProducts(input: SearchProductsInput): Promise<ProductSearchResult>;
  getProducts(input: GetProductsInput): Promise<ProductsResult>;
  /** Product page details in one store; null when the store does not know the product. */
  getProductDetails(storeId: string, id: string): Promise<ProductDetails | null>;
  /** The store's category tree (three levels). */
  getCategories(storeId: string): Promise<Category[]>;
  browseCategory(input: BrowseCategoryInput): Promise<CategoryProductsResult>;
  /** Products by EAN with their sokId, for list writes. Unknown or unsold EANs are missing from the map. */
  getListableProducts(storeId: string, ids: string[]): Promise<Map<string, ListableProduct>>;
  /**
   * S-kaupat's anonymous cart check (validateCart) for these products and quantities in one store,
   * for a chosen delivery or pickup time when given.
   */
  checkBasket(storeId: string, items: { id: string; quantity: number }[], delivery?: BasketDelivery): Promise<Map<string, BasketCheck>>;
}
