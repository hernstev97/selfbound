// What an inbox entry says: "Aleister set the status to Done", with "· 2 more changes" when
// several changes were grouped. The wording of the single change is the activity feed's
// (`historyText`), so English and German exist already.
import { decodeChoice } from '@selfbound/backend/shared/models';
import { historyText } from './app/historyText.ts';
import { actorName } from './format.ts';
import { t, tn } from './i18n.ts';
import type { IssueStore } from './store.ts';
import type { InboxEntry } from './types.ts';

type Change = InboxEntry['changes'][number];

/** Which change leads when several happened at the same moment (a status change brings a priority row). */
const LEAD = ['stateId', 'comment', 'description', 'title'];
const leadRank = (field: string) => {
  const i = LEAD.indexOf(field);
  return i < 0 ? LEAD.length : i;
};

/** The change that stands for the entry: the latest one. */
export function leadChange(entry: Pick<InboxEntry, 'changes'>): Change | undefined {
  let lead: Change | undefined;
  for (const c of entry.changes) if (!lead || c.at > lead.at || (c.at === lead.at && leadRank(c.field) < leadRank(lead.field))) lead = c;
  return lead;
}

/** A change as the history row the activity wording expects. */
function asHistory(c: Change) {
  const relation = (value: unknown) => {
    const [type, direction, otherId] = typeof value === 'string' ? value.split(':') : [];
    return { type, direction, otherId };
  };
  const team = (value: unknown) => (typeof value === 'string' ? { identifier: value } : undefined);
  let to: unknown = c.value;
  let from: unknown = c.from;
  if (c.field === 'relation') to = relation(c.value);
  else if (c.field === 'relation_removed') from = relation(c.value);
  else if (c.field === 'teamId') {
    to = team(c.value);
    from = team(c.from);
  } else if (c.field === 'labelIds') to = c.value ?? [];
  else if (c.field === 'model') to = typeof c.value === 'string' ? (decodeChoice(c.value) ?? undefined) : undefined;
  return { field: c.field, from, to, actor: c.actor };
}

function changeText(c: Change, store: IssueStore): string {
  switch (c.field) {
    case 'comment':
      return t('added a comment');
    case 'comment_edited':
      return t('edited a comment');
    case 'comment_removed':
      return t('removed a comment');
    default:
      return historyText(asHistory(c), store) ?? t('changed the issue');
  }
}

/** One line for the entry. */
export function entryText(entry: InboxEntry, store: IssueStore, agents: ReadonlyMap<string, string>): string {
  const lead = leadChange(entry);
  if (!lead && entry.kind === 'snoozed') return t('Back from snooze');
  if (!lead) return t('{actor} created the issue', { actor: actorName(entry.actor, agents) });
  const text = t('{actor} {action}', { actor: actorName(lead.actor, agents), action: changeText(lead, store) });
  const more = entry.changes.length - 1;
  return more > 0 ? `${text} · ${tn(more, '{count} more change', '{count} more changes')}` : text;
}
