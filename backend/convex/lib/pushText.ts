// Texts of push notifications. People read them outside the UI, so the backend translates them
// itself (no import from core): English by default, German when the Convex env var
// XLR8_LOCALE=de is set. Same scheme as the UI: the English text is the key, `{name}` are
// placeholders. Placeholders without a value stay in the text, so bundle titles keep `{n}`
// until bundleMessages fills in the count.

export type PushLocale = 'en' | 'de';

const DE: Record<string, string> = {
  '{name} · New issue': '{name} · Neues Issue',
  '{name} · {n} new issues': '{name} · {n} neue Issues',
  '{name} commented on {id}': '{name} kommentiert {id}',
  '{name} · {n} comments on {id}': '{name} · {n} Kommentare zu {id}',
  'PR #{number} merged': 'PR #{number} gemergt',
  'PR #{number} merged · {id} done': 'PR #{number} gemergt · {id} erledigt',
  'PR #{number} linked to {id}': 'PR #{number} verknüpft mit {id}',
  'PR #{number} merged · {n} issues': 'PR #{number} gemergt · {n} Issues',
  'PR #{number} linked · {n} issues': 'PR #{number} verknüpft · {n} Issues',
  'Sprint {number} ends today': 'Sprint {number} endet heute',
  'Sprint {number} ends tomorrow': 'Sprint {number} endet morgen',
  '{done} of {total} issue done.': '{done} von {total} Issues erledigt.',
  '{done} of {total} issues done.': '{done} von {total} Issues erledigt.',
  '{id} is due today': '{id} ist heute fällig',
  '{id} is overdue': '{id} ist überfällig',
  '{count} due today': '{count} heute fällig',
  '{count} overdue': '{count} überfällig',
  '{id} is back from snooze': '{id} ist zurück aus der Zurückstellung',
  '{n} snoozed issues are back': '{n} zurückgestellte Issues sind zurück',
  'and {count} more': 'und {count} weitere',
  '[Image]': '[Bild]',
  'Test notification: notifications work on this device.': 'Testmeldung: Benachrichtigungen funktionieren auf diesem Gerät.',
};

/** Locale of push texts from XLR8_LOCALE (`de`, `de-DE` … → German; anything else → English). */
export function pushLocale(env: Record<string, string | undefined> = process.env): PushLocale {
  return (env.XLR8_LOCALE ?? '').trim().toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** Translates an English push text and fills in its placeholders (one pass: values are not re-scanned). */
export function pushText(english: string, params: Record<string, string | number> = {}, locale: PushLocale = pushLocale()): string {
  const template = locale === 'de' ? (DE[english] ?? english) : english;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** For tests: every German entry must use exactly the placeholders of its English key. */
export const PUSH_DE: Readonly<Record<string, string>> = DE;
