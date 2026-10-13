// "Repeat …" in the more menu: a recurrence template from an issue (own small chunk, loaded on demand).
import { api } from '@xlr8/backend/api';
import { intlLocale, t } from '../i18n.ts';
import type { IssueId } from '../types.ts';
import type { App } from './index.ts';

/** Weekday name in the UI language; `day` 1 = Monday … 7 = Sunday (5 Jan 2026 was a Monday). */
function weekdayName(day: number) {
  return new Date(2026, 0, 4 + day).toLocaleDateString(intlLocale(), { weekday: 'long' });
}

/** Copies team, title, description, priority, labels, project and estimate. */
export async function repeatIssue(app: App, id: IssueId, cadence: 'weekly' | 'monthly', day: number) {
  const issue = app.store.get(id);
  if (!issue || issue.pending) return;
  const description = app.store.detail(id)?.body.markdown;
  try {
    await app.store.call(api.recurrences.create, {
      teamId: issue.teamId,
      title: issue.title,
      ...(description ? { description } : {}),
      priority: issue.priority,
      labelIds: issue.labelIds,
      ...(issue.projectId ? { projectId: issue.projectId } : {}),
      ...(issue.estimate !== undefined ? { estimate: issue.estimate } : {}),
      cadence,
      ...(cadence === 'weekly' ? { weekday: day } : { monthDay: day }),
      sourceIssueId: issue._id,
    });
    const text = cadence === 'weekly' ? t('“{title}” repeats every {weekday}', { title: issue.title, weekday: weekdayName(day) }) : t('“{title}” repeats on day {day} of every month', { title: issue.title, day });
    app.toasts.show(text, { label: t('Show'), run: () => app.nav.go({ name: 'settings', section: 'recurrences' }) });
  } catch (error) {
    app.toasts.error(t('Recurrence not created'), error);
  }
}
