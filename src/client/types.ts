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
}
