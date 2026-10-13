// IndexedDB mirror for the warm start.
//
// - Reads in ONE transaction: head (schema, meta, counter) plus all buckets via getAll()
//   (157 single get() calls read noticeably slower).
// - Writes only the changed buckets, batched in idle time. Everything used to live in one entry:
//   every change to an issue cloned all 10,000 on write (≈ 40 ms of main thread at 4× CPU
//   throttling, noticeable while scrolling).
// - The mirror keeps no copy of the data itself, only the buckets not yet written.
// - Schema version: if it differs (new field, different format), the mirror is discarded.

/** Bump on every change to the mirrored format or the issue schema. */
export const MIRROR_SCHEMA = 5;
const DB_VERSION = 2;

export interface MirrorSnapshot {
  schema: number;
  meta: unknown | null;
  maxSeq: number | null;
  /** Open inbox entries (missing in mirrors written before inbox entries had their own table) */
  inbox: unknown[] | null;
  buckets: Record<number, unknown[]>;
}

interface Head {
  schema: number;
  meta: unknown | null;
  maxSeq: number | null;
  inbox?: unknown[] | null;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Mirror {
  #db: Promise<IDBDatabase | null>;
  #head: Head = { schema: MIRROR_SCHEMA, meta: null, maxSeq: null };
  #headDirty = false;
  #dirtyBuckets = new Map<number, unknown[]>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly name: string,
    readonly delayMs = 3000,
  ) {
    this.#db = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      try {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          // Discard the old format (a single "snapshot" entry).
          if (db.objectStoreNames.contains('kv')) db.deleteObjectStore('kv');
          if (db.objectStoreNames.contains('buckets')) db.deleteObjectStore('buckets');
          db.createObjectStore('kv');
          db.createObjectStore('buckets');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  /** Saved state or null (empty, different schema, error). */
  async read(): Promise<MirrorSnapshot | null> {
    const db = await this.#db;
    if (!db) return null;
    try {
      const tx = db.transaction(['kv', 'buckets'], 'readonly');
      const [head, keys, values] = await Promise.all([
        promisify(tx.objectStore('kv').get('head')) as Promise<Head | undefined>,
        promisify(tx.objectStore('buckets').getAllKeys()),
        promisify(tx.objectStore('buckets').getAll()),
      ]);
      if (!head) return null;
      if (head.schema !== MIRROR_SCHEMA) {
        await this.clear();
        return null;
      }
      const buckets: Record<number, unknown[]> = {};
      keys.forEach((key, i) => (buckets[Number(key)] = values[i] as unknown[]));
      // Whatever the server sent in the meantime wins on the next write.
      this.#head = { schema: MIRROR_SCHEMA, meta: this.#head.meta ?? head.meta, maxSeq: this.#head.maxSeq ?? head.maxSeq, inbox: this.#head.inbox ?? head.inbox ?? null };
      return { schema: head.schema, meta: head.meta, maxSeq: head.maxSeq, inbox: head.inbox ?? null, buckets };
    } catch {
      return null;
    }
  }

  setMeta(meta: unknown) {
    this.#head.meta = meta;
    this.#headDirty = true;
    this.#schedule();
  }

  setInbox(inbox: unknown[]) {
    this.#head.inbox = inbox;
    this.#headDirty = true;
    this.#schedule();
  }

  setMaxSeq(maxSeq: number) {
    this.#head.maxSeq = maxSeq;
    this.#headDirty = true;
    this.#schedule();
  }

  setBucket(bucket: number, docs: unknown[]) {
    this.#dirtyBuckets.set(bucket, docs);
    this.#schedule();
  }

  #schedule() {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));
      idle(() => void this.flush(8), { timeout: 3000 });
    }, this.delayMs);
  }

  /**
   * Writes the changed buckets. Cloning happens synchronously in `put`; on the first sync (all 157
   * buckets) that would be ~40 ms in one go at 4× CPU throttling. Hence chunks of at most `chunk`
   * buckets, each in its own idle slice.
   */
  async flush(chunk = Infinity) {
    if (!this.#headDirty && this.#dirtyBuckets.size === 0) return;
    const db = await this.#db;
    if (!db) {
      this.#dirtyBuckets.clear();
      this.#headDirty = false;
      return;
    }
    const idle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));
    while (this.#dirtyBuckets.size > 0) {
      const batch = [...this.#dirtyBuckets].slice(0, chunk);
      for (const [bucket] of batch) this.#dirtyBuckets.delete(bucket);
      await this.#write(db, batch, null);
      if (this.#dirtyBuckets.size > 0 && chunk !== Infinity) await new Promise<void>((resolve) => idle(() => resolve(), { timeout: 2000 }));
    }
    // Head last: without a head the mirror counts as empty, so half-written states do not count.
    if (this.#headDirty) {
      this.#headDirty = false;
      await this.#write(db, [], { ...this.#head });
    }
  }

  async #write(db: IDBDatabase, buckets: [number, unknown[]][], head: Head | null) {
    try {
      const tx = db.transaction(['kv', 'buckets'], 'readwrite');
      const store = tx.objectStore('buckets');
      for (const [bucket, docs] of buckets) store.put(docs, bucket);
      if (head) tx.objectStore('kv').put(head, 'head');
      await new Promise<void>((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      // Storage full or locked: the warm start is only a speed-up.
    }
  }

  async clear() {
    const db = await this.#db;
    if (!db) return;
    try {
      const tx = db.transaction(['kv', 'buckets'], 'readwrite');
      tx.objectStore('kv').clear();
      tx.objectStore('buckets').clear();
    } catch {
      // ignore
    }
  }
}
