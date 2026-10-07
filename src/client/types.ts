/**
 * Domain types for the S-kaupat client. These are this project's own shapes,
 * not S-kaupat's API shapes; adapters translate into them.
 *
 * Rule from the plan: unknown fields stay unknown (null), never guessed.
 */

export interface Store {
  /** Stable S-kaupat store (branch) ID, used as context for product calls. */
  id: string;
  name: string;
  /** Chain brand, e.g. "PRISMA", "S_MARKET", "ALEPA", when known. */
  brand: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  /** Fulfillment modes when known, e.g. "pickup", "delivery". Null = unknown. */
  fulfillmentModes: string[] | null;
}

export type PriceBasis = "per_item" | "per_weight" | "unknown";

export interface Product {
  /** Product ID as S-kaupat identifies it (currently the EAN). */
  id: string;
  storeId: string;
  name: string;
  brand: string | null;
  /** Current shelf price in euros. */
  price: number | null;
  /** Campaign price in euros, when one applies. */
  campaignPrice: number | null;
  priceBasis: PriceBasis;
  /** Comparison (unit) price in euros per comparisonUnit. */
  comparisonPrice: number | null;
  /** Unit for comparisonPrice, e.g. "KG", "L", "KPL". */
  comparisonUnit: string | null;
  /** Pack size as shown by the store, e.g. "1 l", when known. */
  packSize: string | null;
  /** Native quantity unit used when adding to cart, when known. */
  quantityUnit: string | null;
  availability: "available" | "unavailable" | "unknown";
  category: string | null;
  imageUrl: string | null;
  /** ISO timestamp of when this data was fetched. */
  observedAt: string;
}

export interface ProductSearchResult {
  storeId: string;
  query: string;
  /** Total matches reported by S-kaupat, when known. */
  total: number | null;
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
  query: string;
  limit: number;
}

export interface SearchProductsInput {
  storeId: string;
  query: string;
  limit: number;
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
  searchStores(input: SearchStoresInput): Promise<Store[]>;
  searchProducts(input: SearchProductsInput): Promise<ProductSearchResult>;
  getProducts(input: GetProductsInput): Promise<ProductsResult>;
}
