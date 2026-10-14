import { createSubscriber } from 'svelte/reactivity';
import type { Slice } from '@selfbound/core';

/** Binds a core slice: `fromSlice(s).current` is reactive. */
export function fromSlice<T>(slice: Slice<T>): { readonly current: T } {
  const subscribe = createSubscriber((update) => slice.subscribe(update));
  return {
    get current() {
      subscribe();
      return slice.get();
    },
  };
}
