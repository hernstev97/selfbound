// Inbox: an entry is a mark on the issue, not a table of its own.
// Issues created by agents stay in the inbox until the owner removes the entry (`reviewedAt`).
// Snoozed issues that come back (morning job) re-enter it the same way: both marks cleared.
// Viewed means read (`readAt`); read entries stay until the owner removes them.
// Removing and reading never change the issue itself (status, history, `updatedAt`).
// A snoozed issue is out of the inbox until the morning job brings it back (clears the snooze,
// the entry and its read mark).
import type { IssueDoc } from './types.ts';

type Entry = Pick<IssueDoc, 'reviewedAt' | 'readAt' | 'deletedAt' | 'snoozedUntil'>;

/** Is the issue in the inbox? (Deleted ones are not: they are in the trash.) */
export const inInbox = (issue: Entry) => issue.deletedAt === undefined && issue.reviewedAt === undefined && issue.snoozedUntil === undefined;

/** Unread inbox entry (dot in the lists, count in the sidebar). */
export const unread = (issue: Entry) => issue.reviewedAt === undefined && issue.readAt === undefined && issue.snoozedUntil === undefined;
