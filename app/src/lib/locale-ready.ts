// Activates the UI language before the app instance exists (app-instance.ts imports this first).
// The top-level await holds back every module that depends on this one, so the App and its first
// labels are created with the right dictionary. English resolves at once; German waits for its chunk.
import type { LocalePref } from '@xlr8/core/i18n';
import { startLocale } from './i18n.ts';

/** The saved choice, read directly: Prefs (core/src/app/prefs.ts) does not exist yet at this point. */
function savedPref(): LocalePref | undefined {
  try {
    return JSON.parse(globalThis.localStorage?.getItem('xlr8:prefs') ?? '{}')?.locale;
  } catch {
    return undefined;
  }
}

export const locale = await startLocale(savedPref());
