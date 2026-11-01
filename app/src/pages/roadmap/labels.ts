// Display names of the roadmap (SELF-113): stages, project states, periods. Getters translate on every
// read (translated), so this may run at module level.
import { STAGE_LABEL, type PeriodRange, type StageChoice } from '@selfbound/backend/shared/roadmap';
import { intlLocale, t, translated } from '@selfbound/core/i18n';
import { PROJECT_STATE_LABEL } from '@selfbound/core/app/admin';

export const STAGE_TEXT: Record<StageChoice, string> = translated({ ...STAGE_LABEL });

export const PROJECT_STATE_TEXT: Record<string, string> = PROJECT_STATE_LABEL;

/** "Q1 2027" or "March 2027". */
export function periodText(period: PeriodRange | null): string | null {
  if (!period) return null;
  if (period.kind === 'quarter') return t('Q{quarter} {year}', { quarter: period.index, year: period.year });
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(period.year, period.index - 1, 1));
}

/** Short month name of a 1-based month ("Jan", "Feb"). */
export function monthText(year: number, month: number, style: 'short' | 'narrow' = 'short'): string {
  return new Intl.DateTimeFormat(intlLocale(), { month: style, timeZone: 'UTC' }).format(Date.UTC(year, month - 1, 1));
}

/** A day number (core/src/roadmap.ts) as a date ("12 Mar 2027"). */
export function dayText(day: number): string {
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(day * 86_400_000);
}
