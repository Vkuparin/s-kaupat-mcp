import type { OpeningDay, OpeningStatus } from "./client/types.js";

const CHAIN_NAMES: Record<string, string> = {
  PRISMA: "Prisma",
  EPRISMA: "ePrisma",
  S_MARKET: "S-market",
  SALE: "Sale",
  ALEPA: "Alepa",
  ABC: "ABC",
  HERKKU: "Herkku",
  SOKOS_HERKKU: "Sokos Herkku",
  MESTARIN_HERKKU: "Mestarin Herkku",
};

/** S-kaupat reports brands in lowercase ("prisma", "abc"); normalize to the filter's enum spelling. */
export function chainCode(brand: string | null | undefined): string | null {
  if (!brand) return null;
  return brand.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

export function chainName(code: string | null): string | null {
  return code ? (CHAIN_NAMES[code] ?? null) : null;
}

/** Maps one S-kaupat openingTimes entry. Unseen modes become "unknown" rather than guessed. */
export function toOpeningDay(t: {
  date: string;
  day: string;
  mode?: string | null;
  ranges?: { open: string; close: string }[] | null;
}): OpeningDay {
  const ranges = (t.ranges ?? []).map((r) => ({ open: r.open, close: r.close }));
  const mode = t.mode?.toUpperCase() ?? "";
  let status: OpeningStatus = "unknown";
  if (mode === "ALL_DAY") status = "open_24h";
  else if (mode === "RANGE" && ranges.length > 0) status = "open";
  else if (mode.includes("CLOSED")) status = "closed";
  return { date: t.date, day: t.day, status, ranges: status === "open" ? ranges : [] };
}

/** Today's date in Finland (YYYY-MM-DD), which is what S-kaupat's opening hours use. */
export function finnishDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki" }).format(now);
}

export function openingHoursOn(days: OpeningDay[] | undefined, date: string): OpeningDay | null {
  return days?.find((d) => d.date === date) ?? null;
}

/** The next seven days starting from `date`, for a store's detail view. */
export function openingHoursWeek(days: OpeningDay[] | undefined, date: string): OpeningDay[] {
  return (days ?? []).filter((d) => d.date >= date).slice(0, 7);
}
