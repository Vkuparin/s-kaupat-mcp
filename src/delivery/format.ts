import { finnishDate } from "../stores.js";
import type { DeliveryMethod, DeliverySlot, SavedDelivery, SlotStatus } from "./types.js";

/**
 * S-kaupat's DeliveryMethod enum and its express flag. Only PICKUP and HOME_DELIVERY are
 * assumed; anything else stays "unknown" until it is seen live.
 */
export function deliveryMethod(raw: string | null | undefined, isFastTrack: boolean | null | undefined): DeliveryMethod {
  if (isFastTrack) return "express";
  const value = raw?.toUpperCase() ?? "";
  if (value === "PICKUP") return "pickup";
  if (value === "HOME_DELIVERY") return "home_delivery";
  return "unknown";
}

/** How an order from this area reaches the user: collected or brought home. Null when not known. */
export function handoverOf(area: { method: DeliveryMethod; handover?: "pickup" | "home_delivery" | null }): "pickup" | "home_delivery" | null {
  if (area.method === "pickup" || area.method === "home_delivery") return area.method;
  return area.handover ?? null;
}

/** The raw DeliveryMethod as a handover, for express areas. */
export function rawHandover(raw: string | null | undefined): "pickup" | "home_delivery" | null {
  const value = raw?.toUpperCase() ?? "";
  if (value === "PICKUP") return "pickup";
  if (value === "HOME_DELIVERY") return "home_delivery";
  return null;
}

/** A slot's state from its isClosed flag, availability text and closing time. */
export function slotStatus(
  isClosed: boolean | null | undefined,
  availability: string | null | undefined,
  closesAt: string | null,
  now: Date,
): SlotStatus {
  if (isClosed || (closesAt && Date.parse(closesAt) <= now.getTime())) return "closed";
  const value = availability?.toUpperCase() ?? "";
  if (/FULL|UNAVAILABLE|NOT_AVAILABLE|SOLD_OUT|NONE/.test(value)) return "full";
  if (/AVAILABLE|LIMITED|ALMOST|FREE|OPEN/.test(value)) return "available";
  return "unknown";
}

/** S-kaupat timestamps may be ISO strings or epoch milliseconds; returns ISO or null. */
export function isoTime(raw: string | number | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : /^\d{10,}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isNaN(n)) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const parsed = Date.parse(raw as string);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function euros(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** The Finnish local date of an ISO timestamp, falling back to its own date part. */
export function slotDate(start: string): string {
  const t = Date.parse(start);
  return Number.isNaN(t) ? start.slice(0, 10) : finnishDate(new Date(t));
}

/** A chosen slot no longer usable: it has started, ordering has closed, or it was never choosable. */
export function isExpired(slot: DeliverySlot, now: Date): boolean {
  if (Date.parse(slot.start) <= now.getTime()) return true;
  return slot.closesAt !== null && Date.parse(slot.closesAt) <= now.getTime();
}

const FI_METHOD: Record<DeliveryMethod, string> = {
  pickup: "Nouto",
  home_delivery: "Kotiinkuljetus",
  express: "Pikatoimitus",
  unknown: "toimitustapa",
};
const EN_METHOD: Record<DeliveryMethod, string> = {
  pickup: "pickup",
  home_delivery: "home delivery",
  express: "express delivery",
  unknown: "delivery",
};

export function localTime(iso: string): string {
  return new Intl.DateTimeFormat("fi-FI", { timeZone: "Europe/Helsinki", hour: "2-digit", minute: "2-digit" })
    .format(new Date(iso))
    .replace(".", ":");
}

function localDay(iso: string, locale: "fi-FI" | "en-GB"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "Europe/Helsinki", weekday: "short", day: "numeric", month: "numeric" }).format(
    new Date(iso),
  );
}

/**
 * Exactly what to pick in the site's own "Valitse toimitustapa" dialog, because the site keeps its
 * choice in the browser and doesn't know what the user chose here.
 */
export function deliveryInstruction(d: SavedDelivery): { fi: string; en: string } {
  // The place's own name ("Prisma Herttoniemi noutolokero") says more than the store's, unless it is
  // just the method and the store ("Nouto Prisma Herttoniemi").
  const name = d.area.name?.trim();
  // Home delivery areas have internal names ("Kotiinkuljetus Pääalue alk. 24.11.25", seen live): use the store's.
  const where =
    d.area.method !== "home_delivery" && name && !/^nouto\b/i.test(name) ? name : (d.area.storeName ?? name ?? "");
  const window = d.slot.end ? `${localTime(d.slot.start)}–${localTime(d.slot.end)}` : localTime(d.slot.start);
  return {
    fi: `Valitse sivulla "Valitse toimitustapa": ${FI_METHOD[d.area.method]}, ${where}, ${localDay(d.slot.start, "fi-FI")} klo ${window}.`,
    en: `On the site, under "Valitse toimitustapa" choose ${EN_METHOD[d.area.method]}, ${where}, ${localDay(d.slot.start, "en-GB")} ${window}.`,
  };
}
