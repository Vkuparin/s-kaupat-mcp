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
  /**
   * The next free slot, so an app can show "next: tomorrow 10–12" without the calendar. S-kaupat
   * reports only its start and price here, so end and closesAt are null: it may be about to close.
   */
  nextSlot: DeliverySlot | null;
}

/** The area with its slots between two dates, oldest first. */
export interface DeliveryCalendar {
  area: DeliveryArea;
  slots: DeliverySlot[];
}

/** One match of an address search (the site's "Toimitusvaihtoehdot" search box). */
export interface AddressSuggestion {
  /** S-kaupat's id for the match; only meaningful together with the other fields. */
  addressId: string;
  /** What the site shows, e.g. "Kauppakartanonkatu 7, Helsinki". */
  title: string;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** S-kaupat's kind of match as it reports it, e.g. "place" for a pickup place. */
  kind: string | null;
  /** For a pickup place match: its areaId, usable with get_delivery_slots directly. */
  areaId: string | null;
}

/** Where to look for delivery: a postal code and coordinates, as an address search returns them. */
export interface DeliveryLocation {
  postalCode: string;
  latitude: number;
  longitude: number;
}

/** Whether one way of getting the order (pickup, home delivery, express) is offered at a location. */
export interface DeliveryMethodAvailability {
  method: DeliveryMethod;
  /** null when S-kaupat reported a status this server does not know. */
  available: boolean | null;
  /** S-kaupat's own name, in Finnish ("Nouto", "Kotiinkuljetus", "Pikatoimitus"). */
  name: string | null;
  /** S-kaupat's own short summary in Finnish, e.g. "8,90–14,90 €, huomenna". */
  summary: string | null;
  /** S-kaupat's method codes under it, e.g. PICKUP_PLANNED, HOME_DELIVERY_ONE_HOUR. */
  variants: string[];
}

/** A pickup place near a location, with its times on one day. */
export interface NearbyPickup {
  area: DeliveryArea;
  /** Distance from the location in metres, rounded (S-kaupat reports metres; confirmed live 2026-10-08). */
  distanceMeters: number | null;
  slots: DeliverySlot[];
}

export interface DeliveryApi {
  /**
   * Pickup areas of one store (its own pickup counter, lockers, pickup points). `searchTexts`
   * (the store's name, postal code, city) widen S-kaupat's search, which may need text.
   */
  getPickupAreas(storeId: string, searchTexts?: string[]): Promise<DeliveryArea[]>;
  /** One area with its slots from startDate to endDate (YYYY-MM-DD, inclusive); null when unknown. */
  getDeliveryCalendar(areaId: string, startDate: string, endDate: string): Promise<DeliveryCalendar | null>;
  /** Addresses and pickup places matching what the user typed. */
  findAddresses(text: string): Promise<AddressSuggestion[]>;
  /** Which ways of getting the order are offered at a location. */
  getDeliveryMethods(location: DeliveryLocation): Promise<DeliveryMethodAvailability[]>;
  /** Pickup places near a location with their times on `date`, nearest first. */
  getPickupPlacesNear(location: DeliveryLocation, date: string, limit: number): Promise<NearbyPickup[]>;
}

/** What the user chose, as saved next to the store choice. */
export interface SavedDelivery {
  area: Omit<DeliveryArea, "nextSlot">;
  slot: DeliverySlot;
  selectedAt: string;
}
