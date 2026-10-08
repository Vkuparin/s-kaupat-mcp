import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../log.js";

/**
 * Orders placed through this server, with the access token S-kaupat gives each new order. The token
 * authorises looking at and cancelling that order, like a password for it: it stays in this file
 * (readable by the user only) and is never returned by a tool or logged.
 */
export interface PlacedOrderRecord {
  orderId: string;
  orderNumber: string | null;
  accessToken: string | null;
  storeId: string;
  placedAt: string;
}

export interface OrderStore {
  get(orderId: string): PlacedOrderRecord | null;
  /** Newest first. */
  list(): PlacedOrderRecord[];
  save(record: PlacedOrderRecord): void;
  /** Forgets every order (on log out: the access tokens belong to that account). */
  clear(): void;
}

/** Older entries are dropped: an order is long done after this many. */
const KEEP = 50;

export class MemoryOrderStore implements OrderStore {
  private records: PlacedOrderRecord[] = [];
  get(orderId: string): PlacedOrderRecord | null {
    return this.records.find((r) => r.orderId === orderId) ?? null;
  }
  list(): PlacedOrderRecord[] {
    return [...this.records];
  }
  save(record: PlacedOrderRecord): void {
    this.records = [record, ...this.records.filter((r) => r.orderId !== record.orderId)].slice(0, KEEP);
  }
  clear(): void {
    this.records = [];
  }
}

export class FileOrderStore implements OrderStore {
  constructor(private readonly path: string) {}

  get(orderId: string): PlacedOrderRecord | null {
    return this.read().find((r) => r.orderId === orderId) ?? null;
  }

  list(): PlacedOrderRecord[] {
    return this.read();
  }

  save(record: PlacedOrderRecord): void {
    const records = [record, ...this.read().filter((r) => r.orderId !== record.orderId)].slice(0, KEEP);
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ orders: records }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows keeps the file in the user's own profile folder; chmod is best effort.
    }
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }

  private read(): PlacedOrderRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(text) as { orders?: unknown };
      return Array.isArray(parsed.orders) ? (parsed.orders as PlacedOrderRecord[]).filter((r) => typeof r?.orderId === "string") : [];
    } catch {
      log.warn("The orders file could not be read; starting a new one");
      return [];
    }
  }
}
