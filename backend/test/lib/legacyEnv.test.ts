import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { envVar, resetLegacyEnvWarnings } from '../../convex/lib/legacyEnv';

// legacy-xlr8: SELFBOUND_<NAME> wins; XLR8_<NAME> is the fallback and warns once per variable.

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetLegacyEnvWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('envVar', () => {
  test('the new name is read without a warning', () => {
    expect(envVar('OWNER_IDS', { SELFBOUND_OWNER_IDS: 'a|1' })).toBe('a|1');
    expect(warn).not.toHaveBeenCalled();
  });

  test('the new name wins over the old one, even when empty', () => {
    expect(envVar('OWNER_IDS', { SELFBOUND_OWNER_IDS: 'new', XLR8_OWNER_IDS: 'old' })).toBe('new');
    expect(envVar('OWNER_IDS', { SELFBOUND_OWNER_IDS: '', XLR8_OWNER_IDS: 'old' })).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  test('only the old name: used, one warning per variable and process, never the value', () => {
    const env = { XLR8_OWNER_IDS: 'secret-value', XLR8_LOCALE: 'de' };
    expect(envVar('OWNER_IDS', env)).toBe('secret-value');
    expect(envVar('OWNER_IDS', env)).toBe('secret-value');
    expect(envVar('LOCALE', env)).toBe('de');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('XLR8_OWNER_IDS is deprecated, set SELFBOUND_OWNER_IDS instead.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value');
  });

  test('neither set: undefined', () => {
    expect(envVar('OWNER_IDS', {})).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
