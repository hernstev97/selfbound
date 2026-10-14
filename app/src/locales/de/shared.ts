// German UI strings (shared), English text → German. See core/src/i18n.ts.
// Labels defined in backend/convex/shared; the UI translates them with t(label).
import type { Dictionary } from '@selfbound/core/i18n';

export default {
  // backend/convex/shared/workflow.ts: STATE_TYPE_LABEL (Triage and Backlog are the same in German)
  Unstarted: 'Geplant',
  Started: 'Begonnen',
  Completed: 'Erledigt',
  Canceled: 'Abgebrochen',

  // backend/convex/shared/notifyEvents.ts: NOTIFY_EVENTS labels and hints
  'New issue from an agent': 'Neues Issue von einem Agenten',
  'An agent creates an issue in the inbox. Several at once arrive as one notification.':
    'Ein Agent legt ein Issue im Eingang an. Mehrere auf einmal kommen als eine Meldung.',
  'Comment from an agent': 'Kommentar von einem Agenten',
  'An agent comments on an issue.': 'Ein Agent kommentiert ein Issue.',
  'Due and overdue': 'Fällig und überfällig',
  'A morning summary of open issues that are due today or overdue.':
    'Morgens eine Sammelmeldung zu offenen Issues, die heute fällig oder überfällig sind.',
  'PR merged': 'PR gemergt',
  'A pull request linked to an issue was merged (GitHub webhook).':
    'Ein mit einem Issue verknüpfter Pull Request wurde gemergt (GitHub-Webhook).',
  'PR linked': 'PR verknüpft',
  'A pull request was linked to an issue (GitHub webhook).': 'Ein Pull Request wurde mit einem Issue verknüpft (GitHub-Webhook).',
  'Sprint ending': 'Sprint endet',
  'In the morning on the day before the sprint ends and on its last day.':
    'Morgens am Tag vor dem Sprintende und am letzten Tag.',
  'Snoozed issue is back': 'Zurückgestelltes Issue ist zurück',
  'In the morning of the chosen day a snoozed issue returns to the inbox.':
    'Am gewählten Tag kommt ein zurückgestelltes Issue morgens zurück in den Eingang.',
} satisfies Dictionary;
