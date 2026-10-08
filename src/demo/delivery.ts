import { slotStatus } from "../delivery/format.js";
import type {
  AddressSuggestion,
  DeliveryArea,
  DeliveryCalendar,
  DeliveryLocation,
  DeliveryMethodAvailability,
  DeliverySlot,
  NearbyPickup,
} from "../delivery/types.js";
import type { Store } from "../client/types.js";
import { finnishDate } from "../stores.js";

/**
 * Made-up pickup areas and times for demo mode and tests: each store has a pickup counter, and the
 * first store also a pickup locker. Two-hour slots from 10 to 20; the 16–18 slot is full on even
 * days, and ordering closes three hours before a slot starts.
 */
const SLOT_HOURS = [10, 12, 14, 16, 18];
const SLOT_PRICES = [3.9, 3.9, 4.9, 5.9, 4.9];

export function demoPickupAreas(store: Store, index: number, now: Date): DeliveryArea[] {
  const areas: DeliveryArea[] = [area(store, `demo-pickup-${store.id}`, `Nouto ${store.name}`, 3.9, now)];
  if (index === 0) areas.push(area(store, `demo-locker-${store.id}`, `Noutolokero ${store.name}`, 2.9, now));
  return areas;
}

export function demoCalendar(store: Store, index: number, areaId: string, startDate: string, endDate: string, now: Date): DeliveryCalendar | null {
  const found = demoPickupAreas(store, index, now).find((a) => a.areaId === areaId);
  if (!found) return null;
  const slots: DeliverySlot[] = [];
  for (let date = startDate; date <= endDate; date = nextDate(date)) slots.push(...daySlots(areaId, date, now));
  return { area: found, slots };
}

function area(store: Store, areaId: string, name: string, price: number, now: Date): DeliveryArea {
  const today = finnishDate(now);
  const nextSlot =
    [today, nextDate(today), nextDate(nextDate(today))].flatMap((d) => daySlots(areaId, d, now)).find((s) => s.status === "available") ?? null;
  return {
    areaId,
    name,
    method: "pickup",
    storeId: store.id,
    storeName: store.name,
    price,
    description: null,
    address: { street: store.street, postalCode: store.postalCode, city: store.city },
    alcoholAllowed: true,
    nextSlot,
  };
}

function daySlots(areaId: string, date: string, now: Date): DeliverySlot[] {
  const evenDay = Number(date.slice(8, 10)) % 2 === 0;
  return SLOT_HOURS.map((hour, i) => {
    const start = helsinkiIso(date, hour);
    const closesAt = new Date(Date.parse(start) - 3 * 3_600_000).toISOString();
    const full = evenDay && hour === 16;
    return {
      slotId: `${areaId}-${date}-${hour}`,
      areaId,
      date,
      start,
      end: helsinkiIso(date, hour + 2),
      price: SLOT_PRICES[i] ?? null,
      status: slotStatus(false, full ? "FULL" : "AVAILABLE", closesAt, now),
      closesAt,
      express: false,
    };
  });
}

function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The ISO instant of a whole hour on a Finnish local date. */
function helsinkiIso(date: string, hour: number): string {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const local = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "Europe/Helsinki" }));
  const utc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess - (local.getTime() - utc.getTime())).toISOString();
}

/** Made-up addresses for demo mode: a home in Helsinki and one in Tampere. */
const DEMO_ADDRESSES: AddressSuggestion[] = [
  { addressId: "demo-address-1", title: "Esimerkkitie 5, Helsinki", street: "Esimerkkitie 5", postalCode: "00100", city: "Helsinki", latitude: 60.171, longitude: 24.941, kind: "address" },
  { addressId: "demo-address-2", title: "Mallikatu 10, Tampere", street: "Mallikatu 10", postalCode: "33100", city: "Tampere", latitude: 61.49, longitude: 23.77, kind: "address" },
];

export function demoAddresses(text: string): AddressSuggestion[] {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return [];
  return DEMO_ADDRESSES.filter((a) => words.every((w) => a.title.toLowerCase().includes(w)));
}

/** Pickup everywhere; home delivery in the Helsinki area (postal codes 00…); express only in 00100. */
export function demoDeliveryMethods(location: DeliveryLocation): DeliveryMethodAvailability[] {
  const helsinki = location.postalCode.startsWith("00");
  return [
    { method: "pickup", available: true, name: "Nouto", summary: "0–5,90 €, tänään", variants: ["PICKUP_PLANNED"] },
    {
      method: "home_delivery",
      available: helsinki,
      name: "Kotiinkuljetus",
      summary: helsinki ? "8,90–14,90 €, huomenna" : "Ei saatavilla",
      variants: ["HOME_DELIVERY_PLANNED"],
    },
    {
      method: "express",
      available: location.postalCode === "00100",
      name: "Pikatoimitus",
      summary: location.postalCode === "00100" ? "Noin tunti tilauksesta" : "Ei saatavilla",
      variants: ["HOME_DELIVERY_ONE_HOUR"],
    },
  ];
}

export function demoPickupNear(stores: Store[], location: DeliveryLocation, date: string, limit: number, now: Date): NearbyPickup[] {
  return stores
    .flatMap((store, index) => {
      if (!store.coordinates) return [];
      const distance = Math.round(metres(location.latitude, location.longitude, store.coordinates.lat, store.coordinates.lon));
      return demoPickupAreas(store, index, now).map((area) => ({
        area,
        distance,
        slots: demoCalendar(store, index, area.areaId, date, date, now)?.slots ?? [],
      }));
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}
