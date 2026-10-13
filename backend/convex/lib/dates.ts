// Calendar days in Europe/Berlin, without Intl: the EU daylight saving rule is fixed (last Sunday
// in March 01:00 UTC to last Sunday in October 01:00 UTC), so nothing depends on the runtime's
// time zone database. A calendar day is a string "YYYY-MM-DD".

export type Day = string;

export const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of summer time or winter time in a year (UTC milliseconds). */
function lastSundayAt1Utc(year: number, monthIndex: number) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  return Date.UTC(year, monthIndex, lastDay.getUTCDate() - lastDay.getUTCDay(), 1, 0, 0);
}

/** Offset of Europe/Berlin from UTC in minutes (60 in winter, 120 in summer). */
export function berlinOffsetMinutes(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  return ms >= lastSundayAt1Utc(year, 2) && ms < lastSundayAt1Utc(year, 9) ? 120 : 60;
}

/** Calendar day in Berlin at a point in time. */
export function berlinDay(ms: number): Day {
  return new Date(ms + berlinOffsetMinutes(ms) * 60_000).toISOString().slice(0, 10);
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

/** Start of a calendar day in Berlin (local midnight) in UTC milliseconds. */
export function berlinDayStart(day: Day): number {
  const midnightUtc = toUtc(day);
  // Local midnight is 1 or 2 hours before midnight UTC; the right one is the offset in effect at that moment.
  for (const offset of [120, 60]) {
    const candidate = midnightUtc - offset * 60_000;
    if (berlinOffsetMinutes(candidate) === offset) return candidate;
  }
  return midnightUtc - 60 * 60_000;
}
