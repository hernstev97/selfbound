// Clerk key for the current address. VITE_CLERK_PUBLISHABLE_KEY is a single key or a list
// `host=key,host=key`: during a domain change both addresses run side by side for a while, each with
// the key of its own Clerk address. Without a matching host there is no key, and sign-in shows its
// notice instead of a foreign Clerk address.
// Separate file without imports: the sign-in page uses it too and must not pull in the app.

export function publishableKeyFor(value: string | undefined, host: string): string | undefined {
  if (!value) return undefined;
  if (!value.includes('=')) return value;
  for (const entry of value.split(',')) {
    const [h, key] = entry.split('=').map((s) => s.trim());
    if (h === host && key) return key;
  }
  return undefined;
}

export const publishableKey = publishableKeyFor(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
  globalThis.location?.hostname ?? '',
);
