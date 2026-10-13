// Smallest common denominator for both frameworks: a value plus a subscription.
// React binds through useSyncExternalStore(slice.subscribe, slice.get),
// Svelte through createSubscriber. `set` notifies only when the reference changes.

export type Listener = () => void;

export class Slice<T> {
  #value: T;
  #listeners = new Set<Listener>();

  constructor(value: T) {
    this.#value = value;
  }

  get = (): T => this.#value;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Is anyone subscribed? (SliceFamily drops slices without subscribers) */
  get observed() {
    return this.#listeners.size > 0;
  }

  set(next: T) {
    if (Object.is(next, this.#value)) return;
    this.#value = next;
    for (const listener of [...this.#listeners]) listener();
  }

  update(fn: (current: T) => T) {
    this.set(fn(this.#value));
  }
}

/**
 * One slice per key, e.g. one row per issue. Slices without subscribers (row no longer on screen)
 * are dropped on the next recompute instead of computed: memory does not grow while scrolling
 * through 10,000 issues, and `refreshAll` only costs the visible rows. Calling `get(key)` again
 * later returns a freshly computed slice.
 */
export class SliceFamily<K, T> {
  #slices = new Map<K, Slice<T>>();
  constructor(private create: (key: K) => T) {}

  get(key: K): Slice<T> {
    let slice = this.#slices.get(key);
    if (!slice) {
      slice = new Slice(this.create(key));
      this.#slices.set(key, slice);
    }
    return slice;
  }

  /** Recompute existing slices only, create no new ones. */
  refresh(key: K, next?: (current: T) => T) {
    const slice = this.#slices.get(key);
    if (!slice) return;
    if (!slice.observed) this.#slices.delete(key);
    else slice.set(next ? next(slice.get()) : this.create(key));
  }

  refreshAll() {
    for (const [key, slice] of this.#slices) {
      if (!slice.observed) this.#slices.delete(key);
      else slice.set(this.create(key));
    }
  }

  /** Drop slices without subscribers (e.g. after scrolling). */
  prune() {
    for (const [key, slice] of this.#slices) if (!slice.observed) this.#slices.delete(key);
  }

  get size() {
    return this.#slices.size;
  }

  clear() {
    this.#slices.clear();
  }
}
