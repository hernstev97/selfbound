// Labels, orders and date formats. Labels translate on read (translated()), dates follow the UI language.
import { intlLocale, locale, t, tn, translated } from './i18n.ts';
import { isOwnerKind, OWNER_KIND, type Actor, type Priority, type Status } from './types.ts';

/** Order in the status picker (workflow). */
export const STATUS_ORDER: Status[] = ['triage', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'duplicate'];
/** Order of groups in lists: started ones at the top, closed ones at the bottom. */
export const STATUS_GROUP_ORDER: Status[] = ['triage', 'in_review', 'in_progress', 'todo', 'backlog', 'done', 'canceled', 'duplicate'];
export const CLOSED: ReadonlySet<Status> = new Set(['done', 'canceled', 'duplicate']);
export const ACTIVE: ReadonlySet<Status> = new Set(['todo', 'in_progress', 'in_review']);

export const STATUS_LABEL: Record<Status, string> = translated({
  triage: 'Triage',
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  canceled: 'Canceled',
  duplicate: 'Duplicate',
});

/** Search words in both languages, so "prog" or "arbeit" + Enter finds "In Progress" in either UI language. */
export const STATUS_KEYWORDS: Record<Status, string> = {
  triage: 'triage eingang',
  backlog: 'backlog',
  todo: 'todo to do offen',
  in_progress: 'in progress started begonnen arbeit',
  in_review: 'in review prüfung',
  done: 'done completed fertig erledigt',
  canceled: 'canceled cancelled abgesagt abgebrochen',
  duplicate: 'duplicate doppelt duplikat',
};

export const PRIORITY_ORDER: Priority[] = [0, 1, 2, 3, 4];
/** Group and sort order: urgent first, "none" last */
export const PRIORITY_GROUP_ORDER: Priority[] = [1, 2, 3, 4, 0];

export const PRIORITY_LABEL: Record<Priority, string> = translated({
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
});

/** Search words in both languages. */
export const PRIORITY_KEYWORDS: Record<Priority, string> = {
  0: 'none no priority keine',
  1: 'urgent dringend',
  2: 'high hoch',
  3: 'medium mittel',
  4: 'low niedrig',
};

/** Sort rank: urgent first, "none" last */
export function priorityRank(p: Priority) {
  return p === 0 ? 5 : p;
}

export const ESTIMATES = [1, 2, 3, 5, 8];

/** Decision for each open issue when a sprint is completed. */
export type Outcome = 'next' | 'backlog' | 'canceled';
export const OUTCOME_LABEL: Record<Outcome, string> = translated({ next: 'Next sprint', backlog: 'Backlog', canceled: 'Cancel' });

// ---------------------------------------------------------------- Time

const DAY = 86_400_000;
// German keeps its own abbreviations ("Okt.", "März" without a dot); other languages use Intl.
const MONTHS_DE = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];
const MONTHS_LONG_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS_SHORT_DE = ['So.', 'Mo.', 'Di.', 'Mi.', 'Do.', 'Fr.', 'Sa.'];

const german = () => locale() === 'de';

/** Cached Intl formatters per language (dates are formatted per list row). */
const formatters = new Map<string, Intl.DateTimeFormat>();
function format(date: Date, name: string, options: Intl.DateTimeFormatOptions) {
  const key = `${intlLocale()}|${name}`;
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(intlLocale(), options)));
  return f.format(date);
}

/** Short weekday names Sunday … Saturday ("Fri", German "Fr."), e.g. for calendar headers. */
export function weekdaysShort(): string[] {
  if (german()) return WEEKDAYS_SHORT_DE;
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => format(new Date(2023, 0, 1 + i), 'weekday', { weekday: 'short' }));
}

/** Short date: "Oct 8" (German "8. Okt."), with the year if it is not the current one. */
export function shortDate(ms: number, now = Date.now()) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (german()) {
    const base = `${d.getDate()}. ${MONTHS_DE[d.getMonth()]}`;
    return sameYear ? base : `${base} ${d.getFullYear()}`;
  }
  return sameYear ? format(d, 'short', { month: 'short', day: 'numeric' }) : format(d, 'shortYear', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "just now", "5 min ago", "3 hours ago", "yesterday", "4 days ago", "2 months ago", else the date. */
export function relativeTime(ms: number, now = Date.now()) {
  const diff = now - ms;
  if (diff < 60_000) return t('just now');
  if (diff < 3_600_000) return t('{count} min ago', { count: Math.floor(diff / 60_000) });
  if (diff < DAY) return tn(Math.floor(diff / 3_600_000), '{count} hour ago', '{count} hours ago');
  const days = Math.floor(diff / DAY);
  if (days === 1) return t('yesterday');
  if (days < 30) return tn(days, '{count} day ago', '{count} days ago');
  if (days < 365) return tn(Math.floor(days / 30), '{count} month ago', '{count} months ago');
  return shortDate(ms, now);
}

/** Date and time for tooltips. */
export function fullDate(ms: number) {
  const d = new Date(ms);
  if (german()) return `${d.getDate()}. ${MONTHS_LONG_DE[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return format(d, 'full', { dateStyle: 'long', timeStyle: 'short' });
}

// ---------------------------------------------------------------- Calendar days (local time)

export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function today(now = Date.now()) {
  return dayOf(new Date(now));
}

/**
 * Calendar day in Europe/Berlin, which is what the server uses (the morning job, the check that a
 * snooze day lies in the future). The picker for snoozing counts from this day, not from the day on
 * the device, so "tomorrow" is never rejected when the device is on another time zone.
 */
export function berlinToday(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day: string, n: number) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return dayOf(d);
}

export function daysBetween(a: string, b: string) {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / DAY);
}

/** "Fri, Oct 10" (German "Fr., 10. Okt."), with the year if it is not the current one. */
export function dayLabel(day: string, now = Date.now()) {
  const d = parseDay(day);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (german()) return `${WEEKDAYS_SHORT_DE[d.getDay()]}, ${d.getDate()}. ${MONTHS_DE[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
  return sameYear ? format(d, 'day', { weekday: 'short', month: 'short', day: 'numeric' }) : format(d, 'dayYear', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** "October 2026" (German "Oktober 2026") for `YYYY-MM`. */
export function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  if (german()) return `${MONTHS_LONG_DE[m - 1]} ${y}`;
  return format(new Date(y, m - 1, 1), 'month', { month: 'long', year: 'numeric' });
}

/** Due date for lists: "Today", "Tomorrow", "Fri", "Oct 10"; overdue is shown in red. */
export function dueLabel(day: string, now = Date.now()) {
  const diff = daysBetween(today(now), day);
  let label: string;
  if (diff === 0) label = t('Today');
  else if (diff === 1) label = t('Tomorrow');
  else if (diff === -1) label = t('Yesterday');
  else if (diff > 1 && diff < 7) label = german() ? WEEKDAYS_SHORT_DE[parseDay(day).getDay()].replace('.', '') : format(parseDay(day), 'weekday', { weekday: 'short' });
  else label = shortDate(parseDay(day).getTime(), now);
  return { label, overdue: diff < 0, soon: diff >= 0 && diff <= 2 };
}

// Due date input: English and German words are accepted in both UI languages.
const WEEKDAY_WORDS: [RegExp, number][] = [
  [/^(?:so(nntag?)?|sun(day)?)\.?$/, 0],
  [/^(?:mo(ntag?)?|mon(day)?)\.?$/, 1],
  [/^(?:di(enstag?)?|tue(s(day)?)?)\.?$/, 2],
  [/^(?:mi(ttwoch)?|wed(nesday)?)\.?$/, 3],
  [/^(?:do(nnerstag?)?|thu(r(s(day)?)?)?)\.?$/, 4],
  [/^(?:fr(eitag?)?|fri(day)?)\.?$/, 5],
  [/^(?:sa(mstag?)?|sat(urday)?)\.?$/, 6],
];

/** Month names and abbreviations in both languages → month (1–12). */
const MONTH_WORDS: [RegExp, number][] = [
  [/^jan(uary|uar)?$/, 1],
  [/^feb(ruary|ruar)?$/, 2],
  [/^(mar(ch)?|mär(z)?|maerz)$/, 3],
  [/^apr(il)?$/, 4],
  [/^(may|mai)$/, 5],
  [/^jun[ei]?$/, 6],
  [/^jul[yi]?$/, 7],
  [/^aug(ust)?$/, 8],
  [/^sep(t(ember)?)?$/, 9],
  [/^(oct(ober)?|okt(ober)?)$/, 10],
  [/^nov(ember)?$/, 11],
  [/^(dec(ember)?|dez(ember)?)$/, 12],
];

function monthOf(word: string): number | null {
  for (const [re, month] of MONTH_WORDS) if (re.test(word)) return month;
  return null;
}

/**
 * Free input → calendar day, English and German: "today"/"heute", "tomorrow"/"morgen",
 * "übermorgen", "fri"/"fr" (next Friday), "next week"/"nächste woche", "+3", "in 3 days"/"in 3 tagen",
 * "2w"/"2 weeks"/"2 wochen", "2026-10-12", "12.10.", "12.10.2027", "oct 12", "12 oct", "12. okt".
 */
export function parseDueInput(input: string, now = Date.now(), base = today(now)): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'heute' || s === 'today') return base;
  if (s === 'morgen' || s === 'tomorrow') return addDays(base, 1);
  if (s === 'übermorgen' || s === 'uebermorgen' || s === 'day after tomorrow') return addDays(base, 2);
  if (s === 'nächste woche' || s === 'naechste woche' || s === 'next week') return addDays(base, 7 - ((parseDay(base).getDay() + 6) % 7));
  let m = /^(?:\+|in )(\d{1,3})(?: ?(?:tagen?|days?|t|d))?$/.exec(s) ?? /^(\d{1,3}) ?(?:days?|d)$/.exec(s);
  if (m) return addDays(base, Number(m[1]));
  m = /^(?:in )?(\d{1,2}) ?(?:wochen?|weeks?|w)$/.exec(s);
  if (m) return addDays(base, Number(m[1]) * 7);
  for (const [re, weekday] of WEEKDAY_WORDS) {
    if (re.test(s)) {
      const current = parseDay(base).getDay();
      const ahead = (weekday - current + 7) % 7 || 7;
      return addDays(base, ahead);
    }
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/.exec(s);
  if (m) return dayInYear(Number(m[1]), Number(m[2]), m[3], base, now);
  // "12 oct", "12. okt", "12 october 2027"
  m = /^(\d{1,2})\.? ?([a-zä]+)\.?(?: (\d{4}))?$/.exec(s);
  if (m && monthOf(m[2])) return dayInYear(Number(m[1]), monthOf(m[2])!, m[3], base, now);
  // "oct 12", "october 12, 2027"
  m = /^([a-zä]+)\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(s);
  if (m && monthOf(m[1])) return dayInYear(Number(m[2]), monthOf(m[1])!, m[3], base, now);
  return null;
}

/** Day and month with an optional year; without a year and already past: next year. */
function dayInYear(d: number, month: number, yearText: string | undefined, base: string, now: number) {
  let year = yearText ? Number(yearText) : new Date(now).getFullYear();
  if (year < 100) year += 2000;
  const day = validDay(year, month, d);
  if (day && !yearText && day < base) return validDay(year + 1, month, d);
  return day;
}

function validDay(y: number, m: number, d: number) {
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return dayOf(date);
}

// ---------------------------------------------------------------- Actors, branch

/** Display name of an actor; the instance owner shows with the profile name, else as "You". */
export function actorName(actor: Actor, agents: ReadonlyMap<string, string>, fallback?: string): string {
  // `agents` also holds the owner's display name once the profile has one (always under OWNER_KIND).
  if (isOwnerKind(actor.kind)) return fallback ?? agents.get(OWNER_KIND) ?? t('You');
  switch (actor.kind) {
    case 'agent':
      return (actor.agentId && agents.get(actor.agentId)) || t('Agent');
    case 'github':
      return 'GitHub';
    case 'import':
      return fallback ?? t('Import');
    case 'system':
      return 'Selfbound';
  }
}

/** Up to two initials of a name: first letter of the first and the last word ("Jane Q. Doe" → "JD"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = (word: string) => Array.from(word)[0]!;
  return (first(words[0]!) + (words.length > 1 ? first(words[words.length - 1]!) : '')).toLocaleUpperCase();
}

/** Stable hue (0–359) for an avatar without a picture, derived from the name. */
export function nameHue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/**
 * Suggested git branch name: `kiu-106-title-slug`, with an optional prefix `prefix/kiu-106-title-slug`
 * (the app passes VITE_SELFBOUND_BRANCH_PREFIX). Umlauts are transliterated (ä → ae).
 */
export function branchName(identifier: string, title: string, prefix?: string) {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const head = prefix?.trim().replace(/\/+$/, '');
  return `${head ? `${head}/` : ''}${identifier.toLowerCase()}${slug ? `-${slug}` : ''}`;
}
