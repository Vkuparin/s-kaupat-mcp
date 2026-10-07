import { readFileSync } from "node:fs";
import { SKaupatError } from "../errors.js";
import type {
  GetProductsInput,
  Product,
  ProductSearchResult,
  ProductsResult,
  SearchProductsInput,
  SearchStoresInput,
  SKaupatClient,
  Store,
} from "./types.js";

type FixtureProduct = Omit<Product, "storeId" | "availability" | "imageUrl" | "observedAt">;

interface Catalogue {
  stores: Store[];
  products: FixtureProduct[];
}

/**
 * Offline client backed by a JSON catalogue. Used for tests and for trying the
 * server in an MCP client without touching S-kaupat (SKAUPAT_MODE=fixtures).
 */
export class FixtureSKaupatClient implements SKaupatClient {
  private readonly catalogue: Catalogue;

  constructor(catalogue: Catalogue | string) {
    this.catalogue =
      typeof catalogue === "string" ? (JSON.parse(readFileSync(catalogue, "utf8")) as Catalogue) : catalogue;
  }

  async searchStores({ query, limit }: SearchStoresInput): Promise<Store[]> {
    const q = normalize(query);
    return this.catalogue.stores
      .filter((s) => [s.name, s.city, s.street, s.postalCode].some((f) => f && normalize(f).includes(q)))
      .slice(0, limit);
  }

  async searchProducts({ storeId, query, limit }: SearchProductsInput): Promise<ProductSearchResult> {
    this.requireStore(storeId);
    const observedAt = new Date().toISOString();
    const q = normalize(query);
    const matches = this.catalogue.products.filter((p) => p.id === query || normalize(p.name).includes(q));
    return {
      storeId,
      query,
      total: matches.length,
      products: matches.slice(0, limit).map((p) => this.toProduct(p, storeId, observedAt)),
      observedAt,
    };
  }

  async getProducts({ storeId, ids }: GetProductsInput): Promise<ProductsResult> {
    this.requireStore(storeId);
    const observedAt = new Date().toISOString();
    return {
      storeId,
      observedAt,
      results: ids.map((id) => {
        const p = this.catalogue.products.find((x) => x.id === id);
        return p
          ? { id, status: "found" as const, product: this.toProduct(p, storeId, observedAt) }
          : { id, status: "not_found" as const, reason: "Not in the fixture catalogue." };
      }),
    };
  }

  private requireStore(storeId: string): void {
    if (!this.catalogue.stores.some((s) => s.id === storeId)) {
      throw new SKaupatError("unavailable", `Store ${storeId} was not found.`, { storeId });
    }
  }

  private toProduct(p: FixtureProduct, storeId: string, observedAt: string): Product {
    return { ...p, storeId, availability: "unknown", imageUrl: null, observedAt };
  }
}

function normalize(s: string): string {
  return s.toLocaleLowerCase("fi-FI").trim();
}
