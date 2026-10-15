import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { Actor } from '../convex/lib/actor';
import { pushLocale, pushText, PUSH_DE } from '../convex/lib/pushText';
import { generateVapidKeys } from '../convex/lib/webpush';
import { addComment } from '../convex/ops/comments';
import { createIssues } from '../convex/ops/issues';
import { berlinHour, bundleMessages, plainPreview, vapidForSending } from '../convex/ops/notify';
import { OWNER_KIND } from '../convex/shared/constants';
import { createOne, fixture, getIssue, setup, type Client, type T } from './helpers';
import { decryptPush, fakeBrowser, type FakeBrowser } from './lib/pushBrowser';

// Notifications: events, bundling, presence, delivery, morning notification, sharing, locale.

async function makeAgent(t: T, name = 'Assistant'): Promise<Actor> {
  const agentId = await t.run(async (ctx) => await ctx.db.insert('agents', { name, createdAt: Date.now() }));
  return { kind: 'agent', agentId };
}

async function events(t: T) {
  return await t.run(async (ctx) => await ctx.db.query('pushEvents').collect());
}

async function subscribe(owner: Client, browser: FakeBrowser, endpoint = 'https://push.example/device-1') {
  await owner.mutation(api.push.subscribe, { endpoint, ...browser.target, device: 'Test · Chrome', vapidKey: process.env.VAPID_PUBLIC_KEY! });
  return endpoint;
}

/** Replaces fetch: records requests to the push service and answers with `status`. */
function stubPushService(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 201 ? '' : 'gone', { status });
    }),
  );
  return calls;
}

async function payload(call: { init: RequestInit }, browser: FakeBrowser) {
  return JSON.parse((await decryptPush(call.init.body as Uint8Array<ArrayBuffer>, browser)).text);
}

beforeEach(async () => {
  const keys = await generateVapidKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = 'https://selfbound.example.com';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  delete process.env.XLR8_LOCALE;
});

describe('events', () => {
  test("an agent's issue creates exactly one event, the owner's issues none", async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb);
    expect(await events(t)).toHaveLength(0);
    const agent = await makeAgent(t);
    const args = { issues: [{ teamId: f.orb, title: 'From the agent' }], requestId: 'agent-1' };
    await t.run(async (ctx) => await createIssues(ctx, agent, args));
    // Retry with the same requestId: no second notification.
    await t.run(async (ctx) => await createIssues(ctx, agent, args));
    const rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'agent_issue', state: 'pending', title: 'Assistant · New issue', body: 'ORB-2 From the agent', url: '/issue/ORB-2' });
  });

  test("an agent's comment; a disabled event kind records nothing", async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const issue = await createOne(owner, f.orb);
    const agent = await makeAgent(t, 'Claude Code');
    await owner.mutation(api.comments.add, { issueId: issue.id, body: 'From the owner' });
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: issue.id, body: '**Done.** See [PR](https://x.example)' }));
    let rows = await events(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'agent_comment', title: 'Claude Code commented on ORB-1', body: 'Done. See PR', tag: `issue:${issue.id}` });

    await owner.mutation(api.push.setEvent, { kind: 'agent_comment', enabled: false });
    await t.run(async (ctx) => await addComment(ctx, agent, { issueId: issue.id, body: 'One more' }));
    rows = await events(t);
    expect(rows).toHaveLength(1);
    const config = await owner.query(api.push.config, {});
    expect(config.events).toMatchObject({ agent_comment: false, agent_issue: true, pr_linked: false });
  });

  test('an unknown event kind is rejected', async () => {
    const { owner } = setup();
    await expect(owner.mutation(api.push.setEvent, { kind: 'nonexistent', enabled: true })).rejects.toThrow('Unknown event kind');
  });
});

describe('delivery', () => {
  test("several issues of an agent arrive as one notification on every device", async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const phone = await fakeBrowser();
    const desktop = await fakeBrowser();
    await subscribe(owner, phone, 'https://push.example/phone');
    await subscribe(owner, desktop, 'https://push.example/desktop');
    const agent = await makeAgent(t);
    await t.run(async (ctx) =>
      await createIssues(ctx, agent, { issues: [1, 2, 3].map((n) => ({ teamId: f.orb, title: `Agent issue ${n}` })) }),
    );
    const calls = stubPushService();
    const result = await t.action(internal.push.deliver, {});
    expect(result).toEqual({ state: 'sending', messages: 1, devices: 2 });
    expect(calls.map((c) => c.url).sort()).toEqual(['https://push.example/desktop', 'https://push.example/phone']);
    const message = await payload(calls.find((c) => c.url.endsWith('phone'))!, phone);
    expect(message).toMatchObject({ title: 'Assistant · 3 new issues', url: '/inbox', lang: 'en' });
    expect(message.body.split('\n')).toEqual(['ORB-1 Agent issue 1', 'ORB-2 Agent issue 2', 'ORB-3 Agent issue 3']);
    expect(calls[0].init.headers).toMatchObject({ Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    expect((await events(t)).every((e) => e.state === 'sent')).toBe(true);
    // A second delivery finds nothing.
    expect(await t.action(internal.push.deliver, {})).toEqual({ state: 'none', messages: 0, devices: 0 });
    expect(calls).toHaveLength(2);
    const config = await owner.query(api.push.config, {});
    expect(config.devices.every((d) => d.lastSentAt !== null && d.failures === 0)).toBe(true);
  });

  test('Selfbound is active on a device: no push, the app shows the notification', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await subscribe(owner, await fakeBrowser());
    const since = Date.now() - 1;
    await owner.mutation(api.push.presence, { device: 'desktop-1', active: true });
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Quiet' }] }));
    const calls = stubPushService();
    expect((await t.action(internal.push.deliver, {})).state).toBe('in_app');
    expect(calls).toHaveLength(0);
    const recent = await owner.query(api.push.recent, { since });
    expect(recent.map((r) => r.body)).toEqual(['ORB-1 Quiet']);

    // Signed off (app hidden): push again.
    await owner.mutation(api.push.presence, { device: 'desktop-1', active: false });
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Loud' }] }));
    expect((await t.action(internal.push.deliver, {})).state).toBe('sending');
    expect(calls).toHaveLength(1);
  });

  test('not confirmed in the app (window just closed): sent by push after 45 s', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await subscribe(owner, await fakeBrowser());
    await owner.mutation(api.push.presence, { device: 'just-closed', active: true });
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Unseen' }, { teamId: f.nova, title: 'Seen' }] }));
    const calls = stubPushService();
    expect((await t.action(internal.push.deliver, {})).state).toBe('in_app');
    const rows = await events(t);
    const seenRow = rows.find((r) => r.body.includes(' Seen'))!;
    await owner.mutation(api.push.seen, { ids: [seenRow._id] });
    // Presence is still valid, the second attempt sends anyway.
    expect(await t.mutation(internal.push.confirmInApp, { ids: rows.map((r) => r._id) })).toEqual({ retried: 1 });
    expect(await t.action(internal.push.deliver, {})).toEqual({ state: 'sending', messages: 1, devices: 1 });
    expect(calls).toHaveLength(1);
    const after = await events(t);
    expect(after.find((r) => r._id === seenRow._id)?.state).toBe('in_app');
    expect(after.find((r) => r._id !== seenRow._id)?.state).toBe('sent');
  });

  test('presence expires after 90 s', async () => {
    vi.useFakeTimers();
    const { t, owner } = setup();
    const f = await fixture(owner);
    await subscribe(owner, await fakeBrowser());
    await owner.mutation(api.push.presence, { device: 'forgotten', active: true });
    vi.advanceTimersByTime(91_000);
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'Anyway' }] }));
    stubPushService();
    expect((await t.action(internal.push.deliver, {})).state).toBe('sending');
  });

  test('an expired subscription (410) is removed, other errors are counted', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    await subscribe(owner, await fakeBrowser());
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'A' }] }));
    stubPushService(500);
    await t.action(internal.push.deliver, {});
    let config = await owner.query(api.push.config, {});
    expect(config.devices[0]).toMatchObject({ failures: 1, lastError: '500 gone' });

    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'B' }] }));
    stubPushService(410);
    await t.action(internal.push.deliver, {});
    config = await owner.query(api.push.config, {});
    expect(config.devices).toHaveLength(0);
  });

  test('skipped without a device or without VAPID keys', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'A' }] }));
    expect((await t.action(internal.push.deliver, {})).state).toBe('skipped');
    await subscribe(owner, await fakeBrowser());
    delete process.env.VAPID_PRIVATE_KEY;
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'B' }] }));
    expect((await t.action(internal.push.deliver, {})).state).toBe('skipped');
    expect((await owner.query(api.push.config, {})).publicKey).toBeNull();
  });

  test('a test notification goes to this device right away, even while the app is open', async () => {
    const { owner } = setup();
    const browser = await fakeBrowser();
    const endpoint = await subscribe(owner, browser);
    await owner.mutation(api.push.presence, { device: 'here', active: true });
    const calls = stubPushService();
    expect(await owner.action(api.push.sendTest, { endpoint })).toEqual({ ok: true, error: null });
    expect(await payload(calls[0], browser)).toMatchObject({ title: 'Selfbound', test: true, url: '/settings/notifications', body: 'Test notification: notifications work on this device.' });
    expect(await owner.action(api.push.sendTest, { endpoint: 'https://push.example/unknown' })).toMatchObject({ ok: false });
  });

  test('devices: subscribing again replaces, unsubscribe and remove', async () => {
    const { owner } = setup();
    const browser = await fakeBrowser();
    const endpoint = await subscribe(owner, browser);
    await subscribe(owner, browser);
    let config = await owner.query(api.push.config, {});
    expect(config.devices).toHaveLength(1);
    await owner.mutation(api.push.unsubscribe, { endpoint });
    expect((await owner.query(api.push.config, {})).devices).toHaveLength(0);
    await subscribe(owner, browser, 'https://push.example/old');
    config = await owner.query(api.push.config, {});
    await owner.mutation(api.push.removeDevice, { id: config.devices[0].id });
    expect((await owner.query(api.push.config, {})).devices).toHaveLength(0);
    await expect(
      owner.mutation(api.push.subscribe, { endpoint: 'http://insecure.example', ...browser.target, device: 'x', vapidKey: 'x' }),
    ).rejects.toThrow('https');
  });
});

describe('bundling', () => {
  const base = { bundle: undefined, issueId: undefined, at: 1 };
  test('comments on the same issue keep the tag, single events stay single', () => {
    const messages = bundleMessages([
      { _id: 'a' as Id<'pushEvents'>, group: 'comment:x', title: 'Bot commented on ORB-1', body: 'one', url: '/issue/ORB-1', tag: 'issue:x', ...base, bundle: { title: 'Bot · {n} comments on ORB-1', url: '/issue/ORB-1' } },
      { _id: 'b' as Id<'pushEvents'>, group: 'due:1', title: 'Due', body: 'f', url: '/active', tag: 'due', ...base },
      { _id: 'c' as Id<'pushEvents'>, group: 'comment:x', title: 'Bot commented on ORB-1', body: 'two', url: '/issue/ORB-1', tag: 'issue:x', ...base, bundle: { title: 'Bot · {n} comments on ORB-1', url: '/issue/ORB-1' } },
    ]);
    expect(messages).toEqual([
      { title: 'Bot · 2 comments on ORB-1', body: 'one\ntwo', url: '/issue/ORB-1', tag: 'issue:x', at: 1 },
      { title: 'Due', body: 'f', url: '/active', tag: 'due', at: 1 },
    ]);
  });

  test('preview from Markdown', () => {
    expect(plainPreview('# Title\n\n- Point *one*\n```js\nx\n```\n![Picture](a.png)')).toBe('Title Point one [Code] [Image]');
    expect(plainPreview('> [!WARNING] Careful\n> Check twice')).toBe('Careful Check twice');
  });
});

describe('morning notification', () => {
  // 2026-10-11 is daylight saving time: 8:00 in Berlin = 6:00 UTC.
  const at = (hourUtc: number) => Date.UTC(2026, 9, 11, hourUtc, 0, 0);

  test('due and overdue: once a day from 8:00; dormant teams and completed issues do not count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(4));
    const { t, owner } = setup();
    const f = await fixture(owner);
    await createOne(owner, f.orb, { title: 'Today', dueDate: '2026-10-11' });
    await createOne(owner, f.orb, { title: 'Yesterday', dueDate: '2026-10-10' });
    await createOne(owner, f.orb, { title: 'Tomorrow', dueDate: '2026-10-12' });
    await createOne(owner, f.orb, { title: 'Done', dueDate: '2026-10-01', status: 'done' });
    await createOne(owner, f.nova, { title: 'Dormant', dueDate: '2026-10-01' });
    await owner.mutation(api.teams.update, { teamId: f.nova, dormant: true });
    expect(berlinHour(at(5))).toBe(7);

    vi.setSystemTime(at(5));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([]);
    vi.setSystemTime(at(6));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual(['due']);
    vi.setSystemTime(at(7));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([]);
    const rows = (await events(t)).filter((e) => e.kind === 'due');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: '1 due today, 1 overdue', body: 'ORB-1 Today\nORB-2 Yesterday', url: '/active?order=due', key: 'due:2026-10-11' });
  });

  test('sprint ends tomorrow, then today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at(6));
    const { t, owner } = setup();
    const f = await fixture(owner);
    const sprintId = await t.run(async (ctx) =>
      await ctx.db.insert('sprints', {
        number: 14,
        name: 'Sprint 14',
        goal: '',
        startDate: '2026-10-05',
        endDate: '2026-10-12',
        state: 'active',
        source: 'xlr8',
        updatedAt: Date.now(),
      }),
    );
    const one = await createOne(owner, f.orb);
    await t.run(async (ctx) => await ctx.db.patch('issues', one.id, { sprintId }));
    expect((await t.mutation(internal.push.morning, {})).sent).toEqual([`sprint_end:${sprintId}:2026-10-11`]);
    const row = (await events(t)).find((e) => e.kind === 'sprint_end');
    expect(row).toMatchObject({ title: 'Sprint 14 ends tomorrow', body: '0 of 1 issue done.', url: '/sprint' });
    vi.setSystemTime(at(6) + 24 * 3600_000);
    await t.mutation(internal.push.morning, {});
    expect((await events(t)).filter((e) => e.kind === 'sprint_end').map((e) => e.title)).toEqual(['Sprint 14 ends tomorrow', 'Sprint 14 ends today']);
  });
});

describe('share to inbox', () => {
  test('creates an issue in the inbox, in triage; the same requestId creates no second one', async () => {
    const { t, owner } = setup();
    const f = await fixture(owner);
    const args = { teamId: f.orb, title: 'Read article', description: 'https://example.com/article', requestId: 'share-1' };
    const first = await owner.mutation(api.issues.share, args);
    const again = await owner.mutation(api.issues.share, args);
    expect(again.issues[0].id).toBe(first.issues[0].id);
    const issue = await getIssue(t, first.issues[0].id);
    expect(issue.reviewedAt).toBeUndefined();
    expect(issue.status).toBe('triage');
    expect(issue.createdBy).toEqual({ kind: OWNER_KIND });
    // The owner shares: no notification.
    expect(await events(t)).toHaveLength(0);
  });
});

describe('locale of push texts', () => {
  test('English by default, German with XLR8_LOCALE=de (the German wording of the original texts)', async () => {
    expect(pushLocale({})).toBe('en');
    expect(pushLocale({ XLR8_LOCALE: 'de-DE' })).toBe('de');
    expect(pushText('{name} · {n} new issues', { name: 'Codex' }, 'de')).toBe('Codex · {n} neue Issues');
    expect(pushText('{id} is due today', { id: 'ORB-1' }, 'en')).toBe('ORB-1 is due today');
    // Values are not scanned for placeholders.
    expect(pushText('{name} commented on {id}', { name: '{id}', id: 'ORB-1' }, 'de')).toBe('{id} kommentiert ORB-1');

    process.env.XLR8_LOCALE = 'de';
    const { t, owner } = setup();
    const f = await fixture(owner);
    const phone = await fakeBrowser();
    await subscribe(owner, phone);
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [1, 2].map((n) => ({ teamId: f.orb, title: `Issue ${n}` })) }));
    const calls = stubPushService();
    await t.action(internal.push.deliver, {});
    expect(await payload(calls[0], phone)).toMatchObject({ title: 'Assistant · 2 neue Issues', lang: 'de' });
  });

  test('every German entry uses the placeholders of its English key', () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [english, german] of Object.entries(PUSH_DE)) expect(names(german), english).toEqual(names(english));
  });
});

describe('VAPID subject', () => {
  test('VAPID_SUBJECT, else XLR8_APP_URL, else a clear error when sending', () => {
    const keys = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' };
    expect(vapidForSending({})).toBeNull();
    expect(vapidForSending({ ...keys, VAPID_SUBJECT: 'mailto:ops@example.com', XLR8_APP_URL: 'https://selfbound.example.com' })?.subject).toBe('mailto:ops@example.com');
    expect(vapidForSending({ ...keys, XLR8_APP_URL: 'https://selfbound.example.com' })?.subject).toBe('https://selfbound.example.com');
    expect(() => vapidForSending(keys)).toThrow('VAPID_SUBJECT');
  });

  test('without a subject the events stay pending and the test notification reports the problem', async () => {
    delete process.env.VAPID_SUBJECT;
    const { t, owner } = setup();
    const f = await fixture(owner);
    const endpoint = await subscribe(owner, await fakeBrowser());
    const agent = await makeAgent(t);
    await t.run(async (ctx) => await createIssues(ctx, agent, { issues: [{ teamId: f.orb, title: 'A' }] }));
    stubPushService();
    await expect(t.action(internal.push.deliver, {})).rejects.toThrow('VAPID_SUBJECT');
    expect((await events(t)).map((e) => e.state)).toEqual(['pending']);
    const test = await owner.action(api.push.sendTest, { endpoint });
    expect(test.ok).toBe(false);
    expect(test.error).toContain('VAPID_SUBJECT');
  });
});
