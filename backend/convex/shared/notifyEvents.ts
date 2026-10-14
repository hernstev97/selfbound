// Events that can trigger a notification. The backend and the settings page read this list.
// This file must not import anything from Convex; it also runs in the browser.
//
// Extension point: a new event = a new entry here + a call `notify(ctx, { kind: '<id>', … })` where
// it happens in the backend (ops/notify.ts). The settings page then shows it on its own.
//
// `label` and `hint` are English UI text; the UI translates them with t() (German in
// app/src/locales/de/shared.ts).

export const NOTIFY_EVENTS = [
  {
    id: 'agent_issue',
    label: 'New issue from an agent',
    hint: 'An agent creates an issue in the inbox. Several at once arrive as one notification.',
    default: true,
  },
  {
    id: 'agent_comment',
    label: 'Comment from an agent',
    hint: 'An agent comments on an issue.',
    default: true,
  },
  {
    id: 'due',
    label: 'Due and overdue',
    hint: 'A morning summary of open issues that are due today or overdue.',
    default: true,
  },
  {
    id: 'snooze',
    label: 'Snoozed issue is back',
    hint: 'In the morning of the chosen day a snoozed issue returns to the inbox.',
    default: true,
  },
  {
    id: 'pr_merged',
    label: 'PR merged',
    hint: 'A pull request linked to an issue was merged (GitHub webhook).',
    default: true,
  },
  {
    id: 'pr_linked',
    label: 'PR linked',
    hint: 'A pull request was linked to an issue (GitHub webhook).',
    default: false,
  },
  {
    id: 'sprint_end',
    label: 'Sprint ending',
    hint: 'In the morning on the day before the sprint ends and on its last day.',
    default: true,
  },
] as const;

export type NotifyKind = (typeof NOTIFY_EVENTS)[number]['id'];

export const NOTIFY_KINDS: readonly NotifyKind[] = NOTIFY_EVENTS.map((e) => e.id);

/** Hour (Europe/Berlin) of the morning notification unless configured otherwise. */
export const DEFAULT_MORNING_HOUR = 8;

/** Enabled events from the stored overrides; missing ones use their default. */
export function enabledEvents(overrides: Record<string, boolean> | undefined): Record<NotifyKind, boolean> {
  const out = {} as Record<NotifyKind, boolean>;
  for (const e of NOTIFY_EVENTS) out[e.id] = overrides?.[e.id] ?? e.default;
  return out;
}

/** Content of a push message (encrypted to the service worker, app/public/sw.js). */
export interface PushMessage {
  title: string;
  body: string;
  /** path in the app, e.g. "/issue/KIU-12" */
  url: string;
  /** The same tag replaces an older notification on the device instead of showing a second one. */
  tag: string;
  /** issue, to close the notification once it is read */
  issueId?: string;
  /** time of the event (ms) */
  at: number;
  /** test notification only: show it even when Selfbound is open */
  test?: boolean;
}
