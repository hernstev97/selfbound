// Picks the UI language at startup and loads its dictionary before the app mounts.
// English has no dictionary, so English starts without waiting (core/src/i18n.ts).
import { resolveLocale, setDictionary, type Locale, type LocalePref } from '@xlr8/core/i18n';

/** Resolves the language and activates it. Resolves when strings can be rendered. */
export function startLocale(pref: LocalePref | undefined): Promise<Locale> | Locale {
  const lang = resolveLocale(pref, globalThis.navigator?.languages ?? []);
  document.documentElement.lang = lang;
  if (lang === 'en') {
    report(setDictionary('en', null));
    return 'en';
  }
  return import('../locales/de/index.ts').then(
    (m) => {
      report(setDictionary('de', m.default));
      return lang;
    },
    () => {
      // Dictionary not loadable (offline on first start): English is better than nothing.
      document.documentElement.lang = 'en';
      setDictionary('en', null);
      return 'en' as Locale;
    },
  );
}

function report(missed: string[]) {
  // Strings translated while a module was evaluated stay English; e2e/tests/i18n.spec.ts watches for this.
  if (missed.length) console.warn(`[i18n] translated before the dictionary was loaded: ${missed.slice(0, 20).join(' | ')}`);
}
