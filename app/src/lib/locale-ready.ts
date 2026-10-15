// Activates the UI language before the app instance exists (app-instance.ts imports this first).
// The top-level await holds back every module that depends on this one, so the App and its first
// labels are created with the right dictionary. English resolves at once; German waits for its chunk.
import type { LocalePref } from '@selfbound/core/i18n';
import { migrateLegacyBrowserStorage } from '@selfbound/core/legacyStorage';
import { startLocale } from './i18n.ts';

// Moves the old `xlr8:*` storage keys (legacy-xlr8) before anything reads a stored value. This is the
// first thing app-instance.ts imports, so it runs before the App, Prefs and the first render
// (the order of a separate side-effect import is not kept across build chunks).
migrateLegacyBrowserStorage();

/** The saved choice, read directly: Prefs (core/src/app/prefs.ts) does not exist yet at this point. */
function savedPref(): LocalePref | undefined {
  try {
    return JSON.parse(globalThis.localStorage?.getItem('selfbound:prefs') ?? '{}')?.locale;
  } catch {
    return undefined;
  }
}

export const locale = await startLocale(savedPref());
