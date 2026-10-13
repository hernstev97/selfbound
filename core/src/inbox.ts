// Inbox: an entry is a note about an issue, in a table of its own (`inboxEntries`). The store merges
// the open entry into the issue (`issue.inbox`), so views and counters keep working per issue.
// Agents that create an issue or change an existing one open the entry or add to it. Removing and
// reading change the entry only, never the issue itself (status, history, `updatedAt`).
import type { Issue } from './types.ts';

type Entry = Pick<Issue, 'inbox' | 'deletedAt'>;

/** Is the issue in the inbox? (Deleted ones are not: they are in the trash.) */
export const inInbox = (issue: Entry) => issue.deletedAt === undefined && issue.inbox !== undefined;

/** Unread inbox entry (dot in the lists, count in the sidebar). */
export const unread = (issue: Entry) => inInbox(issue) && issue.inbox!.readAt === undefined;

/** Place of the entry in the list: its latest change (a created entry: the creation). */
export const inboxAt = (issue: Pick<Issue, 'inbox' | 'createdAt'>) => issue.inbox?.updatedAt ?? issue.createdAt;
