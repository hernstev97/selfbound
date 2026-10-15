// Calendar days in the instance's time zone (an IANA name such as "Europe/Berlin", see
// ops/instance.ts). A calendar day is a string "YYYY-MM-DD". Moments are UTC milliseconds.

export type Day = string;

export const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Used until the owner (or the first sign-in) sets a zone: what every instance did before the setting existed. */
export const DEFAULT_TIME_ZONE = 'Europe/Berlin';

const formats = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  let fmt = formats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Checks a time zone name and fixes its case ("europe/berlin" → "Europe/Berlin"). Returns null if the
 * runtime does not know it. Aliases keep their spelling ("Asia/Kolkata": the runtime reports it as
 * "Asia/Calcutta", but the name the user picked is the one to show again).
 */
export function canonicalTimeZone(value: string): string | null {
  if (value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return null;
  try {
    const resolved = formatterFor(value).resolvedOptions().timeZone;
    return resolved.toLowerCase() === value.toLowerCase() ? resolved : value;
  } catch {
    return null;
  }
}

/** Wall clock in the zone at a moment, as if it were UTC (so the difference to `ms` is the offset). */
function wallClock(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  // Years before 1 or after 9999 do not occur here; Date.UTC maps years 0–99 to 1900+, which is unused.
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** Offset of the zone from UTC in minutes at a moment (e.g. 60 or 120 for Europe/Berlin, 330 for Asia/Kolkata). */
export function zoneOffsetMinutes(ms: number, timeZone: string): number {
  // Drop the milliseconds: the formatter works in whole seconds.
  const whole = Math.floor(ms / 1000) * 1000;
  return Math.round((wallClock(whole, timeZone) - whole) / 60_000);
}

/** Calendar day in the zone at a moment. */
export function dayInZone(ms: number, timeZone: string): Day {
  return new Date(ms + zoneOffsetMinutes(ms, timeZone) * 60_000).toISOString().slice(0, 10);
}

/** Hour (0–23) in the zone at a moment. */
export function hourInZone(ms: number, timeZone: string): number {
  return new Date(ms + zoneOffsetMinutes(ms, timeZone) * 60_000).getUTCHours();
}

export function isDay(value: string): boolean {
  const m = DAY_RE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === value;
}

function toUtc(day: Day): number {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`Not a calendar day: ${day}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function addDays(day: Day, n: number): Day {
  return new Date(toUtc(day) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from a to b (b − a). */
export function daysBetween(a: Day, b: Day): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function weekdayOf(day: Day): number {
  return ((new Date(toUtc(day)).getUTCDay() + 6) % 7) + 1;
}

export function monthDayOf(day: Day): number {
  return Number(day.slice(8, 10));
}

/** Next day with this weekday; `inclusive`: the day itself counts. */
export function nextWeekday(from: Day, weekday: number, inclusive: boolean): Day {
  let diff = (weekday - weekdayOf(from) + 7) % 7;
  if (diff === 0 && !inclusive) diff = 7;
  return addDays(from, diff);
}

/** Next day with this day of the month (1–28); `inclusive`: the day itself counts. */
export function nextMonthDay(from: Day, monthDay: number, inclusive: boolean): Day {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7)) - 1;
  const current = monthDayOf(from);
  const sameMonth = inclusive ? current <= monthDay : current < monthDay;
  const date = new Date(Date.UTC(year, sameMonth ? month : month + 1, monthDay));
  return date.toISOString().slice(0, 10);
}

/** The next Monday after `today` (never `today` itself). */
export function nextMonday(today: Day): Day {
  return nextWeekday(today, 1, false);
}

/**
 * Start of a calendar day in the zone (local midnight) in UTC milliseconds. If the clocks skip
 * midnight (a few zones switch to summer time at 00:00), the day starts at the first moment that exists.
 */
export function dayStartInZone(day: Day, timeZone: string): number {
  const midnight = toUtc(day);
  // Local midnight lies at most 14 hours before or 12 hours after midnight UTC. Take the offsets in
  // effect at both ends of that window; the right candidate is the one that maps back to this day.
  const offsets = new Set([zoneOffsetMinutes(midnight - 14 * 3_600_000, timeZone), zoneOffsetMinutes(midnight + 12 * 3_600_000, timeZone)]);
  const starts = [...offsets].map((o) => midnight - o * 60_000).sort((a, b) => a - b);
  for (const candidate of starts) if (dayInZone(candidate, timeZone) === day && dayInZone(candidate - 1, timeZone) !== day) return candidate;
  return starts[0]!;
}
