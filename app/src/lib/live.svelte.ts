import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
import { app } from '../app-instance.ts';
import { fromSlice } from '../slice.svelte.ts';

/**
 * Subscription for a component (settings, ops): `current` is reactive, undefined = loading.
 * The subscription ends when the component is removed. Call only during initialization.
 */
export function useQuery<Q extends FunctionReference<'query'>>(query: Q, args: FunctionArgs<Q>): { readonly current: FunctionReturnType<Q> | undefined } {
  const watch = app.store.watch(query, args);
  $effect(() => () => watch.release());
  return fromSlice(watch.slice);
}
