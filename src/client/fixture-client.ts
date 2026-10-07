import { readFileSync } from "node:fs";
import { storeNotFound } from "../errors.js";
import { finnishDate } from "../stores.js";
import type {
  GetProductsInput,
  Product,
  ProductSearchResult,
  ProductsResult,
  SearchProductsInput,
  OpeningDay,
  SearchStoresInput,
  SKaupatClient,
  Store,
  StoreDetails,
  StoreSearchResult,
} from "./types.js";

type FixtureProduct = Omit<Product, "storeId" | "availability" | "imageUrl" | "observedAt">;

/** Same opening hours every day: "ALL_DAY", "CLOSED", or one range. */
type FixtureHours = "ALL_DAY" | "CLOSED" | { open: string; close: string };

interface Catalogue {
  stores: (Store & { hours?: FixtureHours })[];
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

  async searchStores({ query, chain, limit }: SearchStoresInput): Promise<StoreSearchResult> {
    const q = query ? normalize(query) : null;
    const matches = this.catalogue.stores
      .filter((s) => !chain || s.chain === chain)
      .filter((s) => !q || [s.name, s.city, s.street, s.postalCode].some((f) => f && normalize(f).includes(q)))
      .map(({ hours: _hours, ...store }) => store);
    return { total: matches.length, stores: matches.slice(0, limit) };
  }

  async getStores(ids: string[]): Promise<Map<string, StoreDetails>> {
    const found = new Map<string, StoreDetails>();
    for (const id of ids) {
      const s = this.catalogue.stores.find((x) => x.id === id);
      if (s) found.set(id, { id, name: s.name, chain: s.chain, openingHours: fixtureHours(s.hours) });
    }
    return found;
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
      throw storeNotFound(storeId);
    }
  }

  private toProduct(p: FixtureProduct, storeId: string, observedAt: string): Product {
    return { ...p, storeId, availability: "unknown", imageUrl: null, observedAt };
  }
}

function normalize(s: string): string {
  return s.toLocaleLowerCase("fi-FI").trim();
}

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** Three weeks of identical days starting today, mirroring the live API's horizon. */
function fixtureHours(hours: FixtureHours | undefined): OpeningDay[] {
  const start = new Date(`${finnishDate(new Date())}T00:00:00Z`);
  return Array.from({ length: 21 }, (_, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const base = { date: d.toISOString().slice(0, 10), day: DAYS[d.getUTCDay()]! };
    if (!hours) return { ...base, status: "unknown" as const, ranges: [] };
    if (hours === "ALL_DAY") return { ...base, status: "open_24h" as const, ranges: [] };
    if (hours === "CLOSED") return { ...base, status: "closed" as const, ranges: [] };
    return { ...base, status: "open" as const, ranges: [{ ...hours }] };
  });
}
