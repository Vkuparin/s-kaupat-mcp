/**
 * Reads the S-kaupat site's own store and delivery choice from its localStorage, in the server's
 * own browser profile. The site keeps that choice in the browser (Apollo client state:
 * selectedStoreId, selectedAreaId, deliverySlotId, deliveryDate…; docs/s-kaupat-api.md section 5),
 * so this is how the server can tell what the site has.
 *
 * The same storage holds the login, so only the choice fields' values are returned. Everything else
 * is described by key names and value types, for working out the storage format; never values.
 */

/** Client-state fields the site's own queries name (site-operations.graphql), all ids, dates or codes. */
const CHOICE_FIELDS = [
  // Seen live (2026-10-08): store-storage.state.storeId, delivery-storage.state.selectedAreaId and
  // .deliveryDetailsInfo.{deliveryDate, deliveryMethod, deliverySlotId}; delivery-state.method.
  "storeId",
  "selectedStoreId",
  "currentStoreId",
  "selectedAreaId",
  "selectedBrand",
  "deliverySlotId",
  "deliveryDate",
  "deliveryMethod",
  "deliveryTime",
  "areaId",
] as const;
type ChoiceField = (typeof CHOICE_FIELDS)[number];

export type SiteChoice = Record<ChoiceField, string | null>;

export interface SiteStorageShape {
  key: string;
  /** Value types only: { field: "string" } and so on; choice fields keep their values. */
  shape: unknown;
}

/** Storage keys and fields whose contents are never described, not even by type. */
const PRIVATE = /token|auth|session|user|profile|email|phone|card|address|customer|password|secret/i;
const MAX_DEPTH = 5;
const MAX_FIELDS = 40;

export function readSiteChoice(entries: [string, string][]): { choice: SiteChoice; storage: SiteStorageShape[] } {
  const choice = Object.fromEntries(CHOICE_FIELDS.map((f) => [f, null])) as SiteChoice;
  const storage: SiteStorageShape[] = [];
  for (const [key, raw] of entries.slice(0, 100)) {
    if (PRIVATE.test(key)) {
      storage.push({ key, shape: "<private>" });
      continue;
    }
    const value = parse(raw);
    collectChoice(value, choice, 0);
    storage.push({ key, shape: describe(value, 0) });
  }
  return { choice, storage };
}

function collectChoice(node: unknown, choice: SiteChoice, depth: number): void {
  if (depth > MAX_DEPTH || node === null || typeof node !== "object") return;
  for (const [field, value] of Object.entries(node as Record<string, unknown>)) {
    if ((CHOICE_FIELDS as readonly string[]).includes(field) && choice[field as ChoiceField] === null && isPlain(value)) {
      choice[field as ChoiceField] = String(value);
    } else if (!PRIVATE.test(field)) {
      collectChoice(typeof value === "string" ? parse(value) : value, choice, depth + 1);
    }
  }
}

function describe(node: unknown, depth: number): unknown {
  if (node === null) return null;
  if (Array.isArray(node)) return depth >= MAX_DEPTH ? "array" : node.length ? [describe(node[0], depth + 1), `…${node.length}`] : [];
  if (typeof node !== "object") return typeof node;
  if (depth >= MAX_DEPTH) return "object";
  const fields = Object.entries(node as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [field, value] of fields.slice(0, MAX_FIELDS)) {
    if (PRIVATE.test(field)) out[field] = "<private>";
    else if ((CHOICE_FIELDS as readonly string[]).includes(field) && isPlain(value)) out[field] = value;
    else out[field] = describe(typeof value === "string" ? parse(value) : value, depth + 1);
  }
  if (fields.length > MAX_FIELDS) out["…"] = fields.length - MAX_FIELDS;
  return out;
}

function isPlain(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value) && String(value).length <= 64;
}

/** A JSON string becomes its value; anything else stays a plain string (described as "string"). */
function parse(raw: string): unknown {
  if (!/^\s*[[{]/.test(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The choice to write into the site's storage, so its own window opens with it. */
export interface SitePrefill {
  storeId: string;
  storeName: string | null;
  /** S-kaupat's chain code, e.g. "PRISMA" or "S_MARKET". */
  chain: string | null;
  areaId: string;
  slotId: string;
  /** YYYY-MM-DD, Finnish local date. */
  date: string;
  /** "12:00", Finnish local start time. */
  time: string;
  price: number | null;
  postalCode: string | null;
  city: string | null;
}

/**
 * The storage entries that make the site show a pickup choice, merged into what it already has, in
 * the layout seen live (2026-10-08, after choosing a pickup time anonymously on the site):
 * store-storage and delivery-storage are { state, version } objects, delivery-state is plain.
 * Fields the server does not know keep the site's own values. Pickup only: home delivery has
 * address fields this server does not fill in.
 */
export function prefillEntries(entries: [string, string][], p: SitePrefill): [string, string][] {
  const current = new Map(entries);
  const persisted = (key: string): { state: Record<string, unknown>; version: number } => {
    const value = parse(current.get(key) ?? "");
    const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const state = obj.state && typeof obj.state === "object" ? (obj.state as Record<string, unknown>) : {};
    return { ...obj, state: { ...state }, version: typeof obj.version === "number" ? obj.version : 0 };
  };
  const brand = p.chain ? p.chain.toLowerCase().replace(/_/g, "-") : null;

  const store = persisted("store-storage");
  const oldStore = (store.state.deliveryStore ?? {}) as Record<string, unknown>;
  const sameStore = oldStore.id === p.storeId;
  store.state.storeId = p.storeId;
  if (brand) store.state.selectedBrand = brand;
  store.state.deliveryStore = {
    __typename: "DeliveryStore",
    availablePaymentMethods: [],
    ...(sameStore ? oldStore : {}),
    id: p.storeId,
    areaId: p.areaId,
    ...(brand ? { brand } : {}),
    ...(p.storeName ? { name: p.storeName } : {}),
  };

  const delivery = persisted("delivery-storage");
  const oldInfo = (delivery.state.deliveryDetailsInfo ?? {}) as Record<string, unknown>;
  delivery.state.selectedAreaId = p.areaId;
  delivery.state.deliveryDetailsInfo = {
    __typename: "DeliveryDetailsInfo",
    additionalInfo: "",
    address: "",
    addressLine1: "",
    addressLine2: null,
    location: null,
    ...oldInfo,
    city: p.city ?? oldInfo.city ?? "",
    postalCode: p.postalCode ?? oldInfo.postalCode ?? "",
    deliveryDate: p.date,
    deliveryMethod: "PICKUP",
    deliverySlotId: p.slotId,
    deliverySlotPrice: p.price ?? 0,
    deliveryTime: p.time,
  };

  const stateValue = parse(current.get("delivery-state") ?? "");
  const state = stateValue && typeof stateValue === "object" && !Array.isArray(stateValue) ? (stateValue as Record<string, unknown>) : {};
  const method = { ...state, method: "PICKUP", homeDeliveryType: state.homeDeliveryType ?? "NORMAL" };

  return [
    ["store-storage", JSON.stringify(store)],
    ["delivery-storage", JSON.stringify(delivery)],
    ["delivery-state", JSON.stringify(method)],
  ];
}
