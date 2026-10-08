import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./client/types.js";
import type { SavedDelivery } from "./delivery/types.js";
import { log } from "./log.js";

/** The user's chosen store as last saved: the store fields plus when it was chosen. */
export interface SavedStore extends Store {
  selectedAt: string;
}

/**
 * Remembers which store the user picked, so product tools can default to it, and the
 * delivery or pickup time they picked. Choosing a store clears a delivery choice that
 * belongs to another store.
 */
export interface StoreSelection {
  get(): SavedStore | null;
  set(store: SavedStore): void;
  getDelivery(): SavedDelivery | null;
  /** null clears the choice. */
  setDelivery(delivery: SavedDelivery | null): void;
}

interface Settings {
  selectedStore: SavedStore | null;
  delivery: SavedDelivery | null;
}

abstract class BaseSelection implements StoreSelection {
  protected abstract read(): Settings;
  protected abstract write(settings: Settings): void;

  get(): SavedStore | null {
    return this.read().selectedStore;
  }

  set(store: SavedStore): void {
    const { delivery } = this.read();
    this.write({ selectedStore: store, delivery: delivery?.area.storeId === store.id ? delivery : null });
  }

  getDelivery(): SavedDelivery | null {
    return this.read().delivery;
  }

  setDelivery(delivery: SavedDelivery | null): void {
    this.write({ ...this.read(), delivery });
  }
}

export class MemoryStoreSelection extends BaseSelection {
  private settings: Settings = { selectedStore: null, delivery: null };
  protected read(): Settings {
    return this.settings;
  }
  protected write(settings: Settings): void {
    this.settings = settings;
  }
}

interface SettingsFile {
  version: 1;
  selectedStore: SavedStore | null;
  delivery?: SavedDelivery | null;
}

/**
 * Keeps the choices in a small JSON settings file so they survive restarts.
 * Holds no credentials. A missing or unreadable file means "nothing chosen".
 */
export class FileStoreSelection extends BaseSelection {
  private cached: Settings | undefined;

  constructor(readonly path: string) {
    super();
  }

  /** Re-read on every use: other server processes may share the file. It is tiny. */
  protected read(): Settings {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SettingsFile>;
      this.cached = {
        selectedStore: parsed.selectedStore?.id ? parsed.selectedStore : null,
        delivery: parsed.delivery?.slot?.slotId && parsed.delivery.area?.areaId ? parsed.delivery : null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read settings file; treating store as not selected", { path: this.path });
      }
      this.cached = { selectedStore: null, delivery: null };
    }
    return this.cached;
  }

  protected write(settings: Settings): void {
    const file: SettingsFile = { version: 1, ...settings };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2));
    renameSync(tmp, this.path);
    this.cached = settings;
  }
}
