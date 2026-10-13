/**
 * Value equality for field values: numbers, strings, IDs, arrays (e.g. label lists) and plain
 * objects. `undefined` and `null` both count as "not set". Arrays are compared in order unless
 * `unordered` is set (label lists are sets: [a, b] equals [b, a]).
 */
export function sameValue(a: unknown, b: unknown, unordered = false): boolean {
  if (a === undefined || a === null) return b === undefined || b === null;
  if (b === undefined || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    if (unordered) {
      const left = a.map(stable).sort();
      const right = b.map(stable).sort();
      return left.every((value, i) => value === right[i]);
    }
    return a.every((value, i) => sameValue(value, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const keysA = Object.keys(ra).filter((k) => ra[k] !== undefined);
    const keysB = Object.keys(rb).filter((k) => rb[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => sameValue(ra[k], rb[k]));
  }
  return a === b;
}

/** Stable string form of a value (sorted keys), for hashes and comparisons. */
export function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value instanceof ArrayBuffer) return `bytes:${value.byteLength}`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(record[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Fast, deterministic hash (cyrb53 twice, a bit over 100 bits) as a hex string.
 * Enough to detect a request ID reused with different arguments.
 * Not a cryptographic hash; agent keys use SHA-256.
 */
export function hashText(text: string): string {
  return (
    cyrb53(text, 0x9e3779b9).toString(16).padStart(14, '0') + cyrb53(text, 0x85ebca6b).toString(16).padStart(14, '0')
  );
}

function cyrb53(text: string, seed: number) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
