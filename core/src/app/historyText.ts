// Wording of a history row after the actor's name ("set the status to Done"): the activity feed
// of the issue and the inbox entries share it.
import { PRIORITY_LABEL, STATUS_LABEL, dayLabel } from '../format.ts';
import { t, tc, translated } from '../i18n.ts';
import type { IssueStore } from '../store.ts';
import { workflowsOf } from '../workflow.ts';
import { OWNER_KIND, type HistoryDoc, type IssueId, type Priority, type Status } from '../types.ts';

export const RELATION_LABEL: Record<string, string> = translated({
  'blocks:out': 'Blocks',
  'blocks:in': 'Blocked by',
  'related:out': 'Related',
  'related:in': 'Related',
  'duplicate:out': 'Duplicate of',
  'duplicate:in': 'Duplicates',
});

/**
 * Event text after the actor's name. The owner is shown as "You" (German "Du"), which needs the
 * second person in German: each text exists as tc('you', …) for the owner and t(…) for others.
 */
export function historyText(h: Pick<HistoryDoc, 'field' | 'from' | 'to' | 'actor'>, store: IssueStore): string | null {
  const meta = store.meta.get();
  // Both calls stay literal so tooling/i18n-check.mjs can check them.
  const own = h.actor.kind === OWNER_KIND;
  const say = (yours: string, theirs: string) => (own ? yours : theirs);
  const keyOf = (id: unknown) => (typeof id === 'string' ? (store.get(id as IssueId)?.key ?? t('an issue')) : t('an issue'));
  const labelName = (id: string) => meta?.labels.find((l) => l._id === id)?.name ?? t('Label');
  const sprintName = (id: unknown) => meta?.sprints.find((s) => s._id === id)?.name ?? t('a sprint');
  switch (h.field) {
    case 'created':
      return say(tc('you', 'created the issue'), t('created the issue'));
    case 'title':
      return say(tc('you', 'changed the title'), t('changed the title'));
    case 'stateId': {
      // Per-team statuses: names from the metadata, archived ones included.
      const workflows = workflowsOf(meta);
      const name = (id: unknown) => (typeof id === 'string' ? (workflows.byId.get(id)?.name ?? t('another status')) : null);
      const from = name(h.from);
      const to = name(h.to) ?? '';
      if (from) return say(tc('you', 'changed the status from {from} to {to}', { from, to }), t('changed the status from {from} to {to}', { from, to }));
      return say(tc('you', 'set the status to {to}', { to }), t('set the status to {to}', { to }));
    }
    case 'status': {
      const to = STATUS_LABEL[h.to as Status] ?? String(h.to);
      if (h.from) {
        const from = STATUS_LABEL[h.from as Status] ?? String(h.from);
        return say(tc('you', 'changed the status from {from} to {to}', { from, to }), t('changed the status from {from} to {to}', { from, to }));
      }
      return say(tc('you', 'set the status to {to}', { to }), t('set the status to {to}', { to }));
    }
    case 'priority': {
      const priority = PRIORITY_LABEL[h.to as Priority] ?? String(h.to);
      return say(tc('you', 'set the priority to {priority}', { priority }), t('set the priority to {priority}', { priority }));
    }
    case 'labelIds': {
      const from = new Set((h.from as string[] | undefined) ?? []);
      const to = new Set((h.to as string[] | undefined) ?? []);
      const added = [...to].filter((x) => !from.has(x)).map(labelName);
      const removed = [...from].filter((x) => !to.has(x)).map(labelName);
      const parts = [added.length ? t('added {labels}', { labels: added.join(', ') }) : '', removed.length ? t('removed {labels}', { labels: removed.join(', ') }) : ''].filter(Boolean);
      if (!parts.length) return null;
      const changes = parts.join(', ');
      return say(tc('you', 'changed labels: {changes}', { changes }), t('changed labels: {changes}', { changes }));
    }
    case 'projectId': {
      if (!h.to) return say(tc('you', 'removed the project'), t('removed the project'));
      const project = meta?.projects.find((p) => p._id === h.to)?.name ?? '…';
      return say(tc('you', 'set the project to {project}', { project }), t('set the project to {project}', { project }));
    }
    case 'estimate': {
      if (h.to === undefined || h.to === null) return say(tc('you', 'removed the estimate'), t('removed the estimate'));
      const points = String(h.to);
      return say(tc('you', 'set the estimate to {points} points', { points }), t('set the estimate to {points} points', { points }));
    }
    case 'dueDate': {
      if (typeof h.to !== 'string') return say(tc('you', 'removed the due date'), t('removed the due date'));
      const date = dayLabel(h.to);
      return say(tc('you', 'set the due date to {date}', { date }), t('set the due date to {date}', { date }));
    }
    case 'parentId': {
      if (!h.to) return say(tc('you', 'removed the parent'), t('removed the parent'));
      const key = keyOf(h.to);
      return say(tc('you', 'set {key} as parent', { key }), t('set {key} as parent', { key }));
    }
    case 'sprint': {
      if (h.to) {
        const sprint = sprintName(h.to);
        return say(tc('you', 'added it to {sprint}', { sprint }), t('added it to {sprint}', { sprint }));
      }
      const sprint = sprintName(h.from);
      return say(tc('you', 'removed it from {sprint}', { sprint }), t('removed it from {sprint}', { sprint }));
    }
    case 'description':
      return say(tc('you', 'changed the description'), t('changed the description'));
    case 'relation': {
      const r = h.to as { type?: string; direction?: string; otherId?: string } | undefined;
      const relation = RELATION_LABEL[`${r?.type}:${r?.direction}`] ?? t('Relation');
      const key = keyOf(r?.otherId);
      return say(tc('you', 'added a relation: {relation} {key}', { relation, key }), t('added a relation: {relation} {key}', { relation, key }));
    }
    case 'relation_removed': {
      const r = h.from as { type?: string; direction?: string; otherId?: string } | undefined;
      const relation = RELATION_LABEL[`${r?.type}:${r?.direction}`] ?? t('Relation');
      const key = keyOf(r?.otherId);
      return say(tc('you', 'removed a relation: {relation} {key}', { relation, key }), t('removed a relation: {relation} {key}', { relation, key }));
    }
    case 'teamId': {
      const from = (h.from as { identifier?: string } | undefined)?.identifier ?? '…';
      const to = (h.to as { identifier?: string } | undefined)?.identifier ?? '…';
      return say(tc('you', 'moved it from {from} to {to}', { from, to }), t('moved it from {from} to {to}', { from, to }));
    }
    case 'deleted':
      return say(tc('you', 'moved it to the trash'), t('moved it to the trash'));
    case 'restored':
      return say(tc('you', 'restored it'), t('restored it'));
    default:
      return null; // rank, seen, comments (shown on their own)
  }
}
