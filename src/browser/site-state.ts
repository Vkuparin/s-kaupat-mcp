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
