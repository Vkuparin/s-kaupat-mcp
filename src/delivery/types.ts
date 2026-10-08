/**
 * Delivery and pickup ("Valitse toimitustapa" on the site). These are this project's own shapes;
 * the adapters translate S-kaupat's deliveryArea and deliverySlot into them.
 *
 * Field values S-kaupat reports in a form not yet seen live map to "unknown" rather than a guess.
 */

/**
 * - pickup: Nouto, collected from the store or a pickup point.
 * - home_delivery: Kotiinkuljetus.
 * - express: Pikatoimitus, a fast delivery only some stores offer.
 */
export type DeliveryMethod = "pickup" | "home_delivery" | "express" | "unknown";

/**
 * - available: can be chosen.
 * - full: all taken.
 * - closed: ordering for it has closed.
 * - unknown: S-kaupat reported a state this server does not know yet; treat as not choosable.
 */
export type SlotStatus = "available" | "full" | "closed" | "unknown";

export interface DeliverySlot {
  slotId: string;
  areaId: string;
  /** Local date in Finland, YYYY-MM-DD. */
  date: string;
  /** ISO timestamps. */
  start: string;
  end: string | null;
  /** Delivery or pickup fee for this slot in euros, when S-kaupat reports one. */
  price: number | null;
  status: SlotStatus;
  /** When ordering for this slot closes (ISO), when known. */
  closesAt: string | null;
  express: boolean;
}

/** A delivery area: one way of getting the order from one store, e.g. pickup at Prisma Herttoniemi. */
export interface DeliveryArea {
  areaId: string;
  /** S-kaupat's own name for it, in Finnish. */
  name: string | null;
  method: DeliveryMethod;
  storeId: string | null;
  storeName: string | null;
  /** Base fee in euros as S-kaupat reports it; each slot may cost something else. */
  price: number | null;
  /** S-kaupat's own description, in Finnish, when it gives one (e.g. where to collect). */
  description: string | null;
  /** Where to collect a pickup order, when known. */
  address: { street: string | null; postalCode: string | null; city: string | null } | null;
  /** Whether alcohol can be ordered here. Null = unknown. */
  alcoholAllowed: boolean | null;
  /** The next free slot, so an app can show "next: tomorrow 10–12" without the calendar. */
  nextSlot: DeliverySlot | null;
}

/** The area with its slots between two dates, oldest first. */
export interface DeliveryCalendar {
  area: DeliveryArea;
  slots: DeliverySlot[];
}

export interface DeliveryApi {
  /** Pickup areas of one store (its own pickup counter, lockers, pickup points). */
  getPickupAreas(storeId: string): Promise<DeliveryArea[]>;
  /** One area with its slots from startDate to endDate (YYYY-MM-DD, inclusive); null when unknown. */
  getDeliveryCalendar(areaId: string, startDate: string, endDate: string): Promise<DeliveryCalendar | null>;
}

/** What the user chose, as saved next to the store choice. */
export interface SavedDelivery {
  area: Omit<DeliveryArea, "nextSlot">;
  slot: DeliverySlot;
  selectedAt: string;
}
