import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Actor } from '../lib/actor';
import { addDays, berlinDay, berlinOffsetMinutes, DAY_MS } from '../lib/dates';
import { pushText } from '../lib/pushText';
import type { VapidKeys } from '../lib/webpush';
import { identifierOf, OPEN_STATUSES } from '../shared/constants';
import { record } from './history';
import { openSnoozedEntry } from './inboxChanges';
import { DEFAULT_MORNING_HOUR, enabledEvents, type NotifyKind, type PushMessage } from '../shared/notifyEvents';

// Notifications: collect events, bundle them and prepare them for delivery (push.ts).
//
// Flow: a change calls notify() in the same transaction. That writes a row to pushEvents (unique
// key, so never twice) and schedules delivery after a short delay, so several issues from one
// agent call arrive as one notification. Delivery claims all waiting rows in one mutation
// (claimPending): if Selfbound is active on a device right now, they go to the app instead of the phone.
//
// Texts are English, or German with XLR8_LOCALE=de (lib/pushText.ts). They are translated when
// the event is recorded, so a stored event keeps its language.

/** Delay before delivery: long enough to bundle a burst of issues or comments. */
export const DELIVER_DELAY_MS = 10_000;
/** A device counts as active for this long after its last presence ping (the app pings every minute). */
export const PRESENCE_MS = 90_000;
export const EVENTS_KEEP_DAYS = 7;
/** The morning notification is still sent up to this hour (Europe/Berlin) if the cron missed it. */
const MORNING_LAST_HOUR = 21;
const BUNDLE_LINES = 4;
const SYSTEM: Actor = { kind: 'system' };

export async function readPushSettings(ctx: QueryCtx) {
  const row = await ctx.db.query('pushSettings').first();
  return { row, events: enabledEvents(row?.events), morningHour: row?.morningHour ?? DEFAULT_MORNING_HOUR };
}

/** VAPID key pair from the env; null = push is not set up on this backend. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  return publicKey && privateKey ? { publicKey, privateKey } : null;
}

/**
 * VAPID keys plus subject for sending; null = push is not set up. The subject (contact for push
 * services, RFC 8292) is VAPID_SUBJECT, else XLR8_APP_URL. With keys but neither of those set,
 * sending fails with this error rather than announcing a made-up contact.
 */
export function vapidForSending(env: Record<string, string | undefined> = process.env): VapidKeys | null {
  const keys = vapidFromEnv(env);
  if (!keys) return null;
  const subject = env.VAPID_SUBJECT?.trim() || env.XLR8_APP_URL?.trim();
  if (!subject) {
    throw new Error('Web Push needs a VAPID subject: set VAPID_SUBJECT (a mailto: or https: URL) or XLR8_APP_URL on the Convex deployment.');
  }
  return { ...keys, subject };
}

export interface NotifyInput {
  kind: NotifyKind;
  key: string;
  title: string;
  body: string;
  url: string;
  /** Default: the key */
  group?: string;
  /** Default: "issue:<id>", else the key */
  tag?: string;
  issueId?: Id<'issues'>;
  bundle?: { title: string; url: string };
}

/** Records an event. Returns false if the event kind is switched off or the event was already recorded. */
export async function notify(ctx: MutationCtx, input: NotifyInput, now = Date.now()): Promise<boolean> {
  const { events } = await readPushSettings(ctx);
  if (!events[input.kind]) return false;
  const seen = await ctx.db
    .query('pushEvents')
    .withIndex('by_key', (q) => q.eq('key', input.key))
    .first();
  if (seen) return false;
  const waiting = await ctx.db
    .query('pushEvents')
    .withIndex('by_state', (q) => q.eq('state', 'pending'))
    .first();
  await ctx.db.insert('pushEvents', {
    key: input.key,
    kind: input.kind,
    group: input.group ?? input.key,
    title: clip(input.title, 120),
    body: clip(input.body, 300),
    url: input.url,
    tag: input.tag ?? (input.issueId ? `issue:${input.issueId}` : input.key),
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.bundle ? { bundle: input.bundle } : {}),
    state: 'pending',
    at: now,
  });
  // A delivery is already scheduled while a fresh row is waiting. If one has been stuck longer, schedule again.
  if (!waiting || waiting.at < now - 4 * DELIVER_DELAY_MS) {
    await ctx.scheduler.runAfter(DELIVER_DELAY_MS, internal.push.deliver, {});
  }
  return true;
}

// ---------------------------------------------------------------- Events

async function agentName(ctx: QueryCtx, actor: Actor) {
  if (actor.kind !== 'agent' || !actor.agentId) return 'Agent';
  return (await ctx.db.get('agents', actor.agentId))?.name ?? 'Agent';
}

async function identifier(ctx: QueryCtx, issue: Doc<'issues'>) {
  const team = await ctx.db.get('teams', issue.teamId);
  return identifierOf(team?.key ?? '?', issue.number);
}

/** An agent created issues; they are in the inbox. */
export async function notifyAgentIssues(
  ctx: MutationCtx,
  actor: Actor,
  created: { id: Id<'issues'>; identifier: string; title: string }[],
  now = Date.now(),
) {
  if (actor.kind !== 'agent' || created.length === 0) return;
  const name = await agentName(ctx, actor);
  for (const issue of created) {
    await notify(
      ctx,
      {
        kind: 'agent_issue',
        key: `issue:${issue.id}`,
        group: `agent_issue:${actor.agentId ?? ''}`,
        title: pushText('{name} · New issue', { name }),
        body: `${issue.identifier} ${issue.title}`,
        url: `/issue/${issue.identifier}`,
        issueId: issue.id,
        bundle: { title: pushText('{name} · {n} new issues', { name }), url: '/inbox' },
      },
      now,
    );
  }
}

/** An agent commented. */
export async function notifyAgentComment(
  ctx: MutationCtx,
  actor: Actor,
  issue: Doc<'issues'>,
  commentId: Id<'comments'>,
  body: string,
  now = Date.now(),
) {
  if (actor.kind !== 'agent') return;
  const name = await agentName(ctx, actor);
  const id = await identifier(ctx, issue);
  await notify(
    ctx,
    {
      kind: 'agent_comment',
      key: `comment:${commentId}`,
      group: `comment:${issue._id}`,
      title: pushText('{name} commented on {id}', { name, id }),
      body: plainPreview(body) || issue.title,
      url: `/issue/${id}`,
      issueId: issue._id,
      bundle: { title: pushText('{name} · {n} comments on {id}', { name, id }), url: `/issue/${id}` },
    },
    now,
  );
}

/** GitHub: PR merged or linked to issues. `closed` = identifiers completed by it. */
export async function notifyPullRequest(
  ctx: MutationCtx,
  kind: 'pr_merged' | 'pr_linked',
  pr: { ref: string; number: number; title: string },
  issues: Doc<'issues'>[],
  closed: readonly string[],
  now = Date.now(),
) {
  for (const issue of issues) {
    const id = await identifier(ctx, issue);
    const merged = kind === 'pr_merged';
    await notify(
      ctx,
      {
        kind,
        key: `${kind}:${pr.ref}:${issue._id}`,
        group: `${kind}:${pr.ref}`,
        title: merged
          ? pushText(closed.includes(id) ? 'PR #{number} merged · {id} done' : 'PR #{number} merged', { number: pr.number, id })
          : pushText('PR #{number} linked to {id}', { number: pr.number, id }),
        body: `${id} ${issue.title}`,
        url: `/issue/${id}`,
        issueId: issue._id,
        bundle: {
          title: pushText(merged ? 'PR #{number} merged · {n} issues' : 'PR #{number} linked · {n} issues', { number: pr.number }),
          url: `/issue/${id}`,
        },
      },
      now,
    );
  }
}

/** Hour (0–23, Europe/Berlin) of a timestamp. */
export function berlinHour(ms: number) {
  return new Date(ms + berlinOffsetMinutes(ms) * 60_000).getUTCHours();
}

/**
 * Morning notifications (hourly cron): due and overdue issues, sprint ending tomorrow or today.
 * At most once a day per notification (the key contains the day).
 */
export async function morning(ctx: MutationCtx, now = Date.now()) {
  const settings = await readPushSettings(ctx);
  const hour = berlinHour(now);
  if (hour < settings.morningHour || hour > MORNING_LAST_HOUR) return { sent: [] as string[] };
  const today = berlinDay(now);
  const sent: string[] = [];
  const done = async (key: string) =>
    (await ctx.db
      .query('pushEvents')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first()) !== null;

  if (settings.events.due && !(await done(`due:${today}`))) {
    const message = await dueMessage(ctx, today);
    if (message && (await notify(ctx, { kind: 'due', key: `due:${today}`, tag: 'due', ...message }, now))) sent.push('due');
  }

  // Snoozed issues come back every day, whether or not the push is switched on.
  if (await returnSnoozed(ctx, today, now)) sent.push('snooze');

  if (settings.events.sprint_end) {
    const active = await ctx.db
      .query('sprints')
      .withIndex('by_state', (q) => q.eq('state', 'active'))
      .take(10);
    for (const sprint of active) {
      const when =
        sprint.endDate === today ? 'Sprint {number} ends today' : sprint.endDate === addDays(today, 1) ? 'Sprint {number} ends tomorrow' : null;
      if (!when) continue;
      const key = `sprint_end:${sprint._id}:${today}`;
      if (await done(key)) continue;
      const issues = await ctx.db
        .query('issues')
        .withIndex('by_sprint', (q) => q.eq('sprintId', sprint._id))
        .take(500);
      const live = issues.filter((i) => i.deletedAt === undefined);
      const finished = live.filter((i) => i.status === 'done').length;
      const ok = await notify(
        ctx,
        {
          kind: 'sprint_end',
          key,
          tag: `sprint_end:${sprint._id}`,
          title: pushText(when, { number: sprint.number }),
          body: pushText(live.length === 1 ? '{done} of {total} issue done.' : '{done} of {total} issues done.', { done: finished, total: live.length }),
          url: '/sprint',
        },
        now,
      );
      if (ok) sent.push(key);
    }
  }
  return { sent };
}

/**
 * Snoozed issues whose day has come (also earlier ones the job missed) leave the snooze and
 * land in the inbox again as unread, with a push (bundled into one). Closed and deleted issues
 * only lose the snooze. Returns whether a push was recorded.
 */
export async function returnSnoozed(ctx: MutationCtx, today: string, now: number): Promise<boolean> {
  const rows = await ctx.db
    .query('issues')
    .withIndex('by_snoozed', (q) => q.gt('snoozedUntil', '').lte('snoozedUntil', today))
    .take(500);
  let pushed = false;
  for (const issue of rows) {
    const until = issue.snoozedUntil!;
    await ctx.db.patch('issues', issue._id, { snoozedUntil: undefined, updatedAt: now });
    await record(ctx, SYSTEM, now, undefined, { issueId: issue._id, field: 'snoozedUntil', from: until });
    if (issue.deletedAt !== undefined || !(OPEN_STATUSES as readonly string[]).includes(issue.status)) continue;
    // Back in the inbox, unread: an inbox entry of its own, the issue keeps its markers.
    await openSnoozedEntry(ctx, issue._id, now);
    const team = await ctx.db.get('teams', issue.teamId);
    if (!team || team.dormant) continue;
    const id = identifierOf(team.key, issue.number);
    const ok = await notify(
      ctx,
      {
        kind: 'snooze',
        key: `snooze:${issue._id}:${until}`,
        group: `snooze:${today}`,
        tag: `snooze:${issue._id}`,
        title: pushText('{id} is back from snooze', { id }),
        body: issue.title,
        url: `/issue/${id}`,
        issueId: issue._id,
        bundle: { title: pushText('{n} snoozed issues are back', {}), url: '/inbox' },
      },
      now,
    );
    pushed ||= ok;
  }
  return pushed;
}

/** Text of the combined "due" notification; null if nothing is due. Dormant teams do not count. */
export async function dueMessage(ctx: QueryCtx, today: string) {
  const found: (Doc<'issues'> & { identifier: string })[] = [];
  const teams = new Map<Id<'teams'>, Doc<'teams'> | null>();
  for (const status of OPEN_STATUSES) {
    const rows = await ctx.db
      .query('issues')
      .withIndex('by_status_due', (q) => q.eq('status', status).gt('dueDate', '').lte('dueDate', today))
      .take(200);
    for (const issue of rows) {
      if (issue.deletedAt !== undefined || issue.snoozedUntil !== undefined) continue;
      if (!teams.has(issue.teamId)) teams.set(issue.teamId, await ctx.db.get('teams', issue.teamId));
      const team = teams.get(issue.teamId);
      if (!team || team.dormant) continue;
      found.push({ ...issue, identifier: identifierOf(team.key, issue.number) });
    }
  }
  if (found.length === 0) return null;
  const dueToday = found.filter((i) => i.dueDate === today);
  const overdue = found.filter((i) => i.dueDate !== today).sort((a, b) => (a.dueDate! < b.dueDate! ? 1 : -1));
  if (found.length === 1) {
    const only = found[0];
    return {
      title: pushText(dueToday.length ? '{id} is due today' : '{id} is overdue', { id: only.identifier }),
      body: only.title,
      url: `/issue/${only.identifier}`,
      issueId: only._id,
    };
  }
  const parts = [
    dueToday.length ? pushText('{count} due today', { count: dueToday.length }) : '',
    overdue.length ? pushText('{count} overdue', { count: overdue.length }) : '',
  ];
  return {
    title: parts.filter(Boolean).join(', '),
    body: lines([...dueToday, ...overdue].map((i) => `${i.identifier} ${i.title}`)),
    url: '/active?order=due',
  };
}

// ---------------------------------------------------------------- Preparing delivery

export interface ClaimResult {
  ids: Id<'pushEvents'>[];
  messages: PushMessage[];
  targets: { id: Id<'pushSubscriptions'>; endpoint: string; p256dh: string; auth: string }[];
  /** in_app | skipped | sending */
  state: 'none' | 'in_app' | 'skipped' | 'sending';
  more: boolean;
}

/** Is Selfbound currently open, visible and in use on any device? */
export async function anyDeviceActive(ctx: QueryCtx, now: number) {
  const row = await ctx.db
    .query('pushPresence')
    .withIndex('by_active', (q) => q.gt('activeUntil', now))
    .first();
  return row !== null;
}

/** How long the app may take to confirm it showed a notification; after that it is sent by push. */
export const IN_APP_CONFIRM_MS = 45_000;

/**
 * Claims all waiting events (in one transaction, so never twice) and decides: app active → show
 * in the app (with a follow-up check, see confirmInApp); no device or no VAPID key → skip;
 * otherwise send.
 */
export async function claimPending(ctx: MutationCtx, now = Date.now(), limit = 100): Promise<ClaimResult> {
  const pending = await ctx.db
    .query('pushEvents')
    .withIndex('by_state', (q) => q.eq('state', 'pending'))
    .take(limit);
  const empty: ClaimResult = { ids: [], messages: [], targets: [], state: 'none', more: false };
  if (pending.length === 0) return empty;
  const active = await anyDeviceActive(ctx, now);
  const toApp = active ? pending.filter((row) => !row.retry) : [];
  const toPush = pending.filter((row) => !toApp.includes(row));
  for (const row of toApp) await ctx.db.patch('pushEvents', row._id, { state: 'in_app', sentAt: now });
  if (toApp.length) {
    await ctx.scheduler.runAfter(IN_APP_CONFIRM_MS, internal.push.confirmInApp, { ids: toApp.map((r) => r._id) });
  }
  const targets = (await ctx.db.query('pushSubscriptions').take(50)).map((s) => ({
    id: s._id,
    endpoint: s.endpoint,
    p256dh: s.p256dh,
    auth: s.auth,
  }));
  const sendable = targets.length > 0 && vapidFromEnv() !== null;
  // Missing VAPID subject: throw here so the events stay pending until the env is fixed.
  if (sendable && toPush.length > 0) vapidForSending();
  for (const row of toPush) await ctx.db.patch('pushEvents', row._id, { state: sendable ? 'sending' : 'skipped' });
  const sending = sendable && toPush.length > 0;
  return {
    ids: toPush.map((p) => p._id),
    messages: sending ? bundleMessages(toPush) : [],
    targets: sending ? targets : [],
    state: sending ? 'sending' : toApp.length ? 'in_app' : 'skipped',
    more: pending.length === limit,
  };
}

/** Follow-up check: events handed to the app that no app confirmed are sent by push after all. */
export async function confirmInApp(ctx: MutationCtx, ids: Id<'pushEvents'>[], now = Date.now()) {
  let retried = 0;
  for (const id of ids) {
    const row = await ctx.db.get('pushEvents', id);
    if (!row || row.state !== 'in_app' || row.seenAt !== undefined) continue;
    await ctx.db.patch('pushEvents', id, { state: 'pending', retry: true, at: now });
    retried++;
  }
  if (retried) await ctx.scheduler.runAfter(0, internal.push.deliver, {});
  return { retried };
}

/** The app showed these notifications (a notice in the visible window). */
export async function markSeen(ctx: MutationCtx, ids: Id<'pushEvents'>[], now = Date.now()) {
  for (const id of ids.slice(0, 50)) {
    const row = await ctx.db.get('pushEvents', id);
    if (row && row.seenAt === undefined) await ctx.db.patch('pushEvents', id, { seenAt: now });
  }
}

/** Combines events of the same group into one notification (in the order recorded). */
export function bundleMessages(events: readonly Pick<Doc<'pushEvents'>, '_id' | 'group' | 'title' | 'body' | 'url' | 'tag' | 'issueId' | 'bundle' | 'at'>[]): PushMessage[] {
  const groups = new Map<string, (typeof events)[number][]>();
  for (const e of events) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  return [...groups.values()].map((items) => {
    const first = items[0];
    const last = items[items.length - 1];
    if (items.length === 1 || !first.bundle) {
      return { title: last.title, body: last.body, url: last.url, tag: last.tag, at: last.at, ...(last.issueId ? { issueId: last.issueId } : {}) };
    }
    const sameTag = items.every((e) => e.tag === first.tag);
    const sameIssue = items.every((e) => e.issueId === first.issueId);
    return {
      title: first.bundle.title.replace('{n}', String(items.length)),
      body: lines(items.map((e) => e.body)),
      url: first.bundle.url,
      tag: sameTag ? first.tag : `${first.group}:${first._id}`,
      at: last.at,
      ...(sameIssue && first.issueId ? { issueId: first.issueId } : {}),
    };
  });
}

/** Records the delivery result per device; removes expired subscriptions (404/410). */
export async function finishDelivery(
  ctx: MutationCtx,
  ids: Id<'pushEvents'>[],
  results: { id: Id<'pushSubscriptions'>; ok: boolean; gone: boolean; error?: string }[],
  now = Date.now(),
) {
  for (const id of ids) {
    const row = await ctx.db.get('pushEvents', id);
    if (row?.state === 'sending') await ctx.db.patch('pushEvents', id, { state: 'sent', sentAt: now });
  }
  await recordResults(ctx, results, now);
}

export async function recordResults(
  ctx: MutationCtx,
  results: { id: Id<'pushSubscriptions'>; ok: boolean; gone: boolean; error?: string }[],
  now = Date.now(),
) {
  for (const r of results) {
    const sub = await ctx.db.get('pushSubscriptions', r.id);
    if (!sub) continue;
    if (r.gone) await ctx.db.delete('pushSubscriptions', sub._id);
    else if (r.ok) await ctx.db.patch('pushSubscriptions', sub._id, { lastSentAt: now, failures: 0, lastError: undefined });
    else await ctx.db.patch('pushSubscriptions', sub._id, { failures: sub.failures + 1, lastError: clip(r.error ?? 'Error', 200) });
  }
}

/** Deletes old events (daily cleanup cron, maintenance.cleanup). */
export async function cleanupPushEvents(ctx: MutationCtx, now: number, limit: number) {
  const old = await ctx.db
    .query('pushEvents')
    .withIndex('by_at', (q) => q.lt('at', now - EVENTS_KEEP_DAYS * DAY_MS))
    .take(limit);
  for (const row of old) await ctx.db.delete('pushEvents', row._id);
  const stale = await ctx.db
    .query('pushPresence')
    .withIndex('by_active', (q) => q.lt('activeUntil', now - DAY_MS))
    .take(limit);
  for (const row of stale) await ctx.db.delete('pushPresence', row._id);
  return old.length + stale.length;
}

// ---------------------------------------------------------------- Text

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function lines(items: string[]) {
  const shown = items.slice(0, BUNDLE_LINES).map((s) => clip(s, 80));
  if (items.length > BUNDLE_LINES) shown.push(pushText('and {count} more', { count: items.length - BUNDLE_LINES }));
  return shown.join('\n');
}

/** Rough Markdown-to-text conversion for the notification preview. */
export function plainPreview(markdown: string, max = 160) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' [Code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ` ${pushText('[Image]')} `)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>\s*\[![A-Za-z]+\][ \t]*/gm, '') // info panel marker, the title stays
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(text, max);
}
