// legacy-xlr8: the move from the old `xlr8:` storage prefix to `selfbound:`.
import { describe, expect, test, vi } from 'vitest';
import { dropLegacyDatabases, migrateLegacyStorage } from '../src/legacyStorage.ts';

/** Minimal Storage with insertion-ordered keys. */
function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('migrateLegacyStorage', () => {
  test('copies old keys to the new prefix and removes the old ones', () => {
    const s = storage({ 'xlr8:prefs': '{"theme":"dark"}', 'xlr8:desc:abc': 'draft', 'xlr8:collapsed:all': '["x"]' });
    migrateLegacyStorage(s);
    expect(Object.fromEntries(s.map)).toEqual({ 'selfbound:prefs': '{"theme":"dark"}', 'selfbound:desc:abc': 'draft', 'selfbound:collapsed:all': '["x"]' });
  });

  test('does not overwrite a value that already exists under the new name, but still drops the old key', () => {
    const s = storage({ 'xlr8:prefs': 'old', 'selfbound:prefs': 'new', 'xlr8:recent': 'r' });
    migrateLegacyStorage(s);
    expect(Object.fromEntries(s.map)).toEqual({ 'selfbound:prefs': 'new', 'selfbound:recent': 'r' });
  });

  test('is idempotent', () => {
    const s = storage({ 'xlr8:prefs': 'p' });
    migrateLegacyStorage(s);
    const once = Object.fromEntries(s.map);
    migrateLegacyStorage(s);
    expect(Object.fromEntries(s.map)).toEqual(once);
  });

  test('ignores foreign keys, similar prefixes and empty values stay empty', () => {
    const s = storage({ other: '1', 'xlr8x:y': '2', 'XLR8:z': '3', 'xlr8:empty': '' });
    migrateLegacyStorage(s);
    expect(Object.fromEntries(s.map)).toEqual({ other: '1', 'xlr8x:y': '2', 'XLR8:z': '3', 'selfbound:empty': '' });
  });

  test('a throwing or missing storage does not break startup', () => {
    expect(() => migrateLegacyStorage(undefined)).not.toThrow();
    const s = storage({ 'xlr8:a': '1' });
    s.setItem = () => {
      throw new Error('quota');
    };
    expect(() => migrateLegacyStorage(s)).not.toThrow();
  });
});

describe('dropLegacyDatabases', () => {
  test('deletes only the databases with the old prefix', async () => {
    const deleteDatabase = vi.fn();
    const databases = async () => [{ name: 'xlr8:https://a.convex.cloud' }, { name: 'selfbound:https://a.convex.cloud' }, { name: 'other' }, {}];
    await dropLegacyDatabases({ deleteDatabase, databases } as never);
    expect(deleteDatabase.mock.calls).toEqual([['xlr8:https://a.convex.cloud']]);
  });

  test('without databases() (older browsers) nothing happens', async () => {
    const deleteDatabase = vi.fn();
    await dropLegacyDatabases({ deleteDatabase } as never);
    expect(deleteDatabase).not.toHaveBeenCalled();
    await expect(dropLegacyDatabases(undefined)).resolves.toBeUndefined();
  });
});
