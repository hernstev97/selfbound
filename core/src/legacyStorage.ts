// One-time move of browser storage from the old product prefix to the new one.
// legacy-xlr8: the old prefix is read here only; a follow-up removes this file.

const OLD = 'xlr8:'; // legacy-xlr8
const NEW = 'selfbound:';

/**
 * Copies every `xlr8:*` key (legacy-xlr8) to `selfbound:*` (unless the new key exists) and removes the old key.
 * One pass over the keys, idempotent, foreign keys stay untouched. Storage may throw (private mode,
 * quota): then the app just starts with defaults.
 */
export function migrateLegacyStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'> | undefined | null): void {
  if (!storage) return;
  try {
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(OLD)) old.push(key);
    }
    for (const key of old) {
      const next = NEW + key.slice(OLD.length);
      if (storage.getItem(next) === null) {
        const value = storage.getItem(key);
        if (value !== null) storage.setItem(next, value);
      }
      storage.removeItem(key);
    }
  } catch {
    // Storage unavailable or full: nothing to migrate.
  }
}

/** Moves local and session storage; call once at startup, before anything reads a stored value. */
export function migrateLegacyBrowserStorage(): void {
  try {
    migrateLegacyStorage(globalThis.localStorage);
    migrateLegacyStorage(globalThis.sessionStorage);
  } catch {
    // Accessing the storage itself can throw (blocked cookies).
  }
}

/**
 * Deletes the IndexedDB cache databases of the old name. They only hold a copy of server data
 * (the mirror, see idb.ts), so nothing is migrated. Fire and forget; `databases()` is missing in
 * older browsers, then the old cache just stays.
 */
export async function dropLegacyDatabases(idb: Pick<IDBFactory, 'deleteDatabase'> & { databases?: IDBFactory['databases'] } | undefined = globalThis.indexedDB): Promise<void> {
  try {
    if (!idb?.databases) return;
    for (const db of await idb.databases()) {
      if (db.name?.startsWith(OLD)) idb.deleteDatabase(db.name);
    }
  } catch {
    // Best effort.
  }
}
