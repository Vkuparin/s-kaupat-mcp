import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "./client/types.js";
import { log } from "./log.js";

/** The user's chosen store as last saved: the store fields plus when it was chosen. */
export interface SavedStore extends Store {
  selectedAt: string;
}

/** Remembers which store the user picked, so product tools can default to it. */
export interface StoreSelection {
  get(): SavedStore | null;
  set(store: SavedStore): void;
}

export class MemoryStoreSelection implements StoreSelection {
  private store: SavedStore | null = null;
  get(): SavedStore | null {
    return this.store;
  }
  set(store: SavedStore): void {
    this.store = store;
  }
}

interface SettingsFile {
  version: 1;
  selectedStore: SavedStore | null;
}

/**
 * Keeps the selection in a small JSON settings file so it survives restarts.
 * Holds no credentials. A missing or unreadable file means "no store selected".
 */
export class FileStoreSelection implements StoreSelection {
  private cached: SavedStore | null | undefined;

  constructor(readonly path: string) {}

  get(): SavedStore | null {
    if (this.cached !== undefined) return this.cached;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SettingsFile>;
      this.cached = parsed.selectedStore?.id ? parsed.selectedStore : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read settings file; treating store as not selected", { path: this.path });
      }
      this.cached = null;
    }
    return this.cached;
  }

  set(store: SavedStore): void {
    const settings: SettingsFile = { version: 1, selectedStore: store };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, this.path);
    this.cached = store;
  }
}

