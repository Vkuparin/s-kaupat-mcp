import { readFileSync } from "node:fs";
import { listNotFound, storeNotFound } from "../errors.js";
import type { ListItemInput, ShoppingList, ShoppingListApi } from "../lists/types.js";
import { finnishDate } from "../stores.js";
import { DEMO_CATALOGUE } from "../demo/catalogue.js";
import { demoAddresses, demoCalendar, demoDeliveryMethods, demoHomeDelivery, demoPickupAreas, demoPickupNear } from "../demo/delivery.js";
import type {
  AddressSuggestion,
  DeliveryApi,
  DeliveryArea,
  DeliveryCalendar,
  DeliveryLocation,
  DeliveryMethodsAnswer,
  NearbyHomeDelivery,
  NearbyPickup,
} from "../delivery/types.js";
import type {
  BasketCheck,
  BrowseCategoryInput,
  Category,
  CategoryProductsResult,
  ProductDetails,
  GetProductsInput,
  ListableProduct,
  Product,
  ProductSearchResult,
  ProductSort,
  ProductsResult,
  SearchProductsInput,
  OpeningDay,
  SearchStoresInput,
  SKaupatClient,
  Store,
  StoreDetails,
  StoreSearchResult,
} from "./types.js";

/** Catalogue entries name the core fields; the rest default to "unknown" values. */
type FixtureProduct = Pick<
  Product,
  "id" | "name" | "brand" | "price" | "campaignPrice" | "priceBasis" | "comparisonPrice" | "comparisonUnit" | "packSize" | "quantityUnit" | "category"
> &
  Partial<Product>;

/** Same opening hours every day: "ALL_DAY", "CLOSED", or one range. */
type StoredItem = ListItemInput & { id: string };

type FixtureHours = "ALL_DAY" | "CLOSED" | { open: string; close: string };

export interface Catalogue {
  stores: (Store & { hours?: FixtureHours })[];
  /** `sokId` is S Group's internal id (needed for list writes); `orderable: false` makes the cart check report it unavailable. */
  products: (FixtureProduct & { sokId?: string; orderable?: boolean; details?: Partial<ProductDetailFields> })[];
  categories?: Category[];
}

type ProductDetailFields = Omit<ProductDetails, keyof Product>;

/**
 * Offline client backed by a JSON catalogue. Used for tests and for trying the
 * server in an MCP client without touching S-kaupat (SKAUPAT_MODE=fixtures).
 */
export class FixtureSKaupatClient implements SKaupatClient, ShoppingListApi, DeliveryApi {
  private readonly catalogue: Catalogue;
  /** In-memory shopping lists, so apps can try the list flow offline. */
  private readonly lists = new Map<string, { id: string; name: string; createdAt: string; items: StoredItem[] }>();
  private nextId = 1;

  /** A catalogue object, or the path of a JSON file with one. Defaults to the built-in demo catalogue. */
  constructor(
    catalogue: Catalogue | string = DEMO_CATALOGUE,
    /** Clock for the demo delivery times, for tests. */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.catalogue =
      typeof catalogue === "string"
        ? (JSON.parse(readFileSync(catalogue, "utf8")) as Catalogue)
        : structuredClone(catalogue);
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

  async searchProducts({ storeId, query, limit, offset = 0, sort = "relevance" }: SearchProductsInput): Promise<ProductSearchResult> {
    this.requireStore(storeId);
    const observedAt = new Date().toISOString();
    const q = normalize(query);
    const matches = sortProducts(
      this.catalogue.products.filter((p) => p.id === query || normalize(p.name).includes(q)),
      sort,
    );
    return {
      storeId,
      query,
      total: matches.length,
      offset,
      sort,
      products: matches.slice(offset, offset + limit).map((p) => this.toProduct(p, storeId, observedAt)),
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

  async getProductDetails(storeId: string, id: string): Promise<ProductDetails | null> {
    this.requireStore(storeId);
    const p = this.catalogue.products.find((x) => x.id === id);
    if (!p) return null;
    return {
      ...this.toProduct(p, storeId, new Date().toISOString()),
      description: null,
      ingredients: null,
      allergens: [],
      nutrients: [],
      countryOfOrigin: null,
      supplier: null,
      netWeightKg: null,
      ...p.details,
    };
  }

  async getCategories(storeId: string): Promise<Category[]> {
    this.requireStore(storeId);
    return this.catalogue.categories ?? [];
  }

  async browseCategory({ storeId, slug, limit, offset = 0, sort = "relevance" }: BrowseCategoryInput): Promise<CategoryProductsResult> {
    this.requireStore(storeId);
    const observedAt = new Date().toISOString();
    // A category includes its subcategories' products (assumed to match the site; only leaf categories were browsed live).
    const matches = sortProducts(
      this.catalogue.products.filter((p) => p.categorySlug === slug || p.categorySlug?.startsWith(`${slug}/`)),
      sort,
    );
    return {
      storeId,
      slug,
      total: matches.length,
      offset,
      sort,
      products: matches.slice(offset, offset + limit).map((p) => this.toProduct(p, storeId, observedAt)),
      observedAt,
    };
  }

  async getListableProducts(storeId: string, ids: string[]): Promise<Map<string, ListableProduct>> {
    this.requireStore(storeId);
    const observedAt = new Date().toISOString();
    const found = new Map<string, ListableProduct>();
    for (const id of ids) {
      const p = this.catalogue.products.find((x) => x.id === id);
      if (p) found.set(id, { product: this.toProduct(p, storeId, observedAt), sokId: p.sokId ?? null });
    }
    return found;
  }

  async checkBasket(storeId: string, items: { id: string; quantity: number }[]): Promise<Map<string, BasketCheck>> {
    this.requireStore(storeId);
    return new Map(
      items.map(({ id }) => {
        const p = this.catalogue.products.find((x) => x.id === id);
        const status = !p ? "not_found" : p.orderable === false ? "unavailable" : "ok";
        return [id, { id, status, label: status === "unavailable" ? "Tilapäisesti loppu" : null }] as const;
      }),
    );
  }

  async getLists(_token: string, storeId: string): Promise<ShoppingList[]> {
    return [...this.lists.values()].map((l) => this.toList(l, storeId));
  }

  async getList(_token: string, listId: string, storeId: string): Promise<ShoppingList | null> {
    const list = this.lists.get(listId);
    return list ? this.toList(list, storeId) : null;
  }

  async createList(_token: string, name: string, storeId: string): Promise<ShoppingList> {
    const list = { id: `fixture-list-${this.nextId++}`, name, createdAt: new Date().toISOString(), items: [] };
    this.lists.set(list.id, list);
    return this.toList(list, storeId);
  }

  async addItem(_token: string, listId: string, item: ListItemInput, storeId: string): Promise<ShoppingList> {
    const list = this.requireList(listId);
    list.items.push({ ...item, id: `fixture-item-${this.nextId++}` });
    return this.toList(list, storeId);
  }

  async removeItem(_token: string, listId: string, itemId: string, storeId: string): Promise<ShoppingList> {
    const list = this.requireList(listId);
    list.items = list.items.filter((i) => i.id !== itemId);
    return this.toList(list, storeId);
  }

  async deleteList(_token: string, listId: string): Promise<void> {
    this.requireList(listId);
    this.lists.delete(listId);
  }

  private requireList(listId: string) {
    const list = this.lists.get(listId);
    if (!list) throw listNotFound(listId);
    return list;
  }

  private toList(l: { id: string; name: string; createdAt: string; items: StoredItem[] }, storeId: string): ShoppingList {
    const observedAt = new Date().toISOString();
    return {
      id: l.id,
      name: l.name,
      createdAt: l.createdAt,
      storeId,
      items: l.items.map((i) => {
        const p = this.catalogue.products.find((x) => x.id === i.ean);
        return {
          itemId: i.id,
          productId: i.ean,
          name: i.name,
          quantity: i.quantity,
          allowSubstitutes: i.isReplaceable,
          product: p ? this.toProduct(p, storeId, observedAt) : null,
        };
      }),
    };
  }

  async getPickupAreas(storeId: string): Promise<DeliveryArea[]> {
    this.requireStore(storeId);
    const index = this.catalogue.stores.findIndex((s) => s.id === storeId);
    return demoPickupAreas(this.catalogue.stores[index]!, index, this.now());
  }

  async getDeliveryCalendar(areaId: string, startDate: string, endDate: string): Promise<DeliveryCalendar | null> {
    for (const [index, store] of this.catalogue.stores.entries()) {
      const calendar = demoCalendar(store, index, areaId, startDate, endDate, this.now());
      if (calendar) return calendar;
    }
    return null;
  }

  async findAddresses(text: string): Promise<AddressSuggestion[]> {
    return demoAddresses(text);
  }

  async getDeliveryMethods(location: DeliveryLocation): Promise<DeliveryMethodsAnswer> {
    return demoDeliveryMethods(location, this.catalogue.stores);
  }

  async getHomeDeliveryNear(postalCode: string, startDate: string, endDate: string): Promise<NearbyHomeDelivery[]> {
    return demoHomeDelivery(this.catalogue.stores, postalCode, startDate, endDate, this.now());
  }

  async getPickupPlacesNear(location: DeliveryLocation, date: string, limit: number): Promise<NearbyPickup[]> {
    return demoPickupNear(this.catalogue.stores, location, date, limit, this.now());
  }

  private requireStore(storeId: string): void {
    if (!this.catalogue.stores.some((s) => s.id === storeId)) {
      throw storeNotFound(storeId);
    }
  }

  private toProduct(entry: Catalogue["products"][number], storeId: string, observedAt: string): Product {
    const { sokId: _sokId, orderable: _orderable, details: _details, ...p } = entry;
    return {
      regularPrice: p.price,
      campaignValidUntil: null,
      lowest30DayPrice: null,
      depositPrice: null,
      approximatePrice: p.priceBasis === "per_weight",
      availability: "unknown",
      categorySlug: null,
      labels: [],
      ageLimited: false,
      frozen: false,
      shelfLocation: null,
      imageUrl: null,
      ...p,
      storeId,
      observedAt,
    };
  }
}

function sortProducts<T extends { price: number | null }>(products: T[], sort: ProductSort): T[] {
  if (sort === "relevance") return products;
  const dir = sort === "price_asc" ? 1 : -1;
  return [...products].sort((a, b) => dir * ((a.price ?? Infinity) - (b.price ?? Infinity)));
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
