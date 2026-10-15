import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { ownerAction, ownerMutation, ownerQuery, ownerWriteMutation } from './lib/auth';
import { invalid } from './lib/errors';
import { pushLocale, pushText } from './lib/pushText';
import { buildPushRequest, pushTopic, type PushTarget, type VapidKeys } from './lib/webpush';
import { timeZoneOf } from './ops/instance';
import { claimPending, confirmInApp as runConfirm, finishDelivery, markSeen, morning as runMorning, PRESENCE_MS, readPushSettings, recordResults, vapidForSending, vapidFromEnv } from './ops/notify';
import { NOTIFY_KINDS, type NotifyKind, type PushMessage } from './shared/notifyEvents';

// Notifications via Web Push. Events are created in ops/notify.ts; this module holds settings,
// devices, presence and delivery.

// ---------------------------------------------------------------- Settings and devices

/** Everything for the settings page: public key (null = push not set up), events, devices. */
export const config = ownerQuery({
  args: {},
  handler: async (ctx) => {
    const settings = await readPushSettings(ctx);
    const devices = await ctx.db.query('pushSubscriptions').take(50);
    return {
      publicKey: vapidFromEnv()?.publicKey ?? null,
      events: settings.events,
      morningHour: settings.morningHour,
      timeZone: await timeZoneOf(ctx),
      devices: devices.map((d) => ({
        id: d._id,
        endpoint: d.endpoint,
        device: d.device,
        vapidKey: d.vapidKey,
        createdAt: d.createdAt,
        lastSentAt: d.lastSentAt ?? null,
        failures: d.failures,
        lastError: d.lastError ?? null,
      })),
    };
  },
});

const MAX_FIELD = 1000;

/** Registers or renews a device (same endpoint = same device). */
export const subscribe = ownerWriteMutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string(), device: v.string(), vapidKey: v.string() },
  handler: async (ctx, args) => {
    let url: URL;
    try {
      url = new URL(args.endpoint);
    } catch {
      invalid('Invalid push endpoint.');
    }
    if (url.protocol !== 'https:') invalid('The push endpoint must use https.');
    for (const value of [args.endpoint, args.p256dh, args.auth, args.vapidKey]) {
      if (value.length > MAX_FIELD) invalid('Push subscription too large.');
    }
    const device = args.device.trim().slice(0, 80) || 'Device';
    const fields = { p256dh: args.p256dh, auth: args.auth, device, vapidKey: args.vapidKey };
    const existing = await ctx.db
      .query('pushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch('pushSubscriptions', existing._id, { ...fields, failures: 0, lastError: undefined });
      return { id: existing._id };
    }
    const id = await ctx.db.insert('pushSubscriptions', { endpoint: args.endpoint, ...fields, createdAt: Date.now(), failures: 0 });
    return { id };
  },
});

/** Unregisters this device (by its endpoint). */
export const unsubscribe = ownerWriteMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('pushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .take(10);
    for (const row of rows) await ctx.db.delete('pushSubscriptions', row._id);
    return { removed: rows.length };
  },
});

/** Removes a device from the list (e.g. an old phone). */
export const removeDevice = ownerWriteMutation({
  args: { id: v.id('pushSubscriptions') },
  handler: async (ctx, args) => {
    if (await ctx.db.get('pushSubscriptions', args.id)) await ctx.db.delete('pushSubscriptions', args.id);
  },
});

/** Switches an event kind on or off. */
export const setEvent = ownerWriteMutation({
  args: { kind: v.string(), enabled: v.boolean() },
  handler: async (ctx, args) => {
    if (!NOTIFY_KINDS.includes(args.kind as NotifyKind)) invalid('Unknown event kind.', { kind: args.kind });
    const { row } = await readPushSettings(ctx);
    const events = { ...(row?.events ?? {}), [args.kind]: args.enabled };
    if (row) await ctx.db.patch('pushSettings', row._id, { events });
    else await ctx.db.insert('pushSettings', { events });
  },
});

// ---------------------------------------------------------------- Presence and in-app notifications

/**
 * The app pings every minute while it is visible and in use (active: true) and signs off when
 * hidden (active: false). No read-only test switch: this is not a data change.
 */
export const presence = ownerMutation({
  args: { device: v.string(), active: v.boolean() },
  handler: async (ctx, args) => {
    const device = args.device.slice(0, 64);
    const activeUntil = args.active ? Date.now() + PRESENCE_MS : 0;
    const row = await ctx.db
      .query('pushPresence')
      .withIndex('by_device', (q) => q.eq('device', device))
      .first();
    if (row) {
      if (row.activeUntil !== activeUntil) await ctx.db.patch('pushPresence', row._id, { activeUntil });
    } else if (args.active) {
      await ctx.db.insert('pushPresence', { device, activeUntil });
    }
  },
});

/** Notifications shown in the app instead of by push (Selfbound was open), since `since`. */
export const recent = ownerQuery({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query('pushEvents')
      .withIndex('by_state', (q) => q.eq('state', 'in_app').gt('at', args.since))
      .take(20);
    return rows.map((r) => ({ id: r._id, title: r.title, body: r.body, url: r.url, tag: r.tag, at: r.at }));
  },
});

/** The app showed these notifications; without this confirmation they are sent by push shortly after. */
export const seen = ownerMutation({
  args: { ids: v.array(v.id('pushEvents')) },
  handler: async (ctx, args) => await markSeen(ctx, args.ids),
});

// ---------------------------------------------------------------- Delivery

type SendResult = { id: Id<'pushSubscriptions'>; ok: boolean; gone: boolean; error?: string };

async function send(target: PushTarget & { id: Id<'pushSubscriptions'> }, message: PushMessage, vapid: VapidKeys): Promise<SendResult> {
  try {
    // `lang` tells the service worker the language of the texts (SELFBOUND_LOCALE).
    const req = await buildPushRequest(target, JSON.stringify({ ...message, lang: pushLocale() }), vapid, {
      ttl: message.test ? 600 : 24 * 3600,
      urgency: 'high',
      topic: await pushTopic(message.tag),
    });
    const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { id: target.id, ok: true, gone: false };
    const text = (await res.text().catch(() => '')).slice(0, 150);
    return { id: target.id, ok: false, gone: res.status === 404 || res.status === 410, error: `${res.status} ${text}`.trim() };
  } catch (error) {
    return { id: target.id, ok: false, gone: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** All notifications to all devices; one result per device (the worst one). */
async function sendAll(targets: (PushTarget & { id: Id<'pushSubscriptions'> })[], messages: PushMessage[], vapid: VapidKeys) {
  return await Promise.all(
    targets.map(async (target) => {
      let result: SendResult = { id: target.id, ok: true, gone: false };
      for (const message of messages) {
        const r = await send(target, message, vapid);
        if (!r.ok) result = r;
        if (r.gone) break;
      }
      return result;
    }),
  );
}

export const claim = internalMutation({
  args: {},
  handler: async (ctx) => await claimPending(ctx),
});

export const finish = internalMutation({
  args: {
    ids: v.array(v.id('pushEvents')),
    results: v.array(v.object({ id: v.id('pushSubscriptions'), ok: v.boolean(), gone: v.boolean(), error: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => await finishDelivery(ctx, args.ids, args.results),
});

/** Delivery (scheduled by notify): claim waiting events, bundle them, send them to all devices. */
export const deliver = internalAction({
  args: {},
  handler: async (ctx): Promise<{ state: string; messages: number; devices: number }> => {
    const job = await ctx.runMutation(internal.push.claim, {});
    const vapid = vapidForSending();
    if (job.state === 'sending' && vapid) {
      const results = await sendAll(job.targets, job.messages, vapid);
      await ctx.runMutation(internal.push.finish, { ids: job.ids, results });
    }
    if (job.more) await ctx.scheduler.runAfter(0, internal.push.deliver, {});
    return { state: job.state, messages: job.messages.length, devices: job.targets.length };
  },
});

export const confirmInApp = internalMutation({
  args: { ids: v.array(v.id('pushEvents')) },
  handler: async (ctx, args) => await runConfirm(ctx, args.ids),
});

/** Hourly (cron): morning notifications about due issues and sprint ends. */
export const morning = internalMutation({
  args: {},
  handler: async (ctx) => await runMorning(ctx),
});

export const subscriptionByEndpoint = internalQuery({
  args: { endpoint: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query('pushSubscriptions')
      .withIndex('by_endpoint', (q) => q.eq('endpoint', args.endpoint))
      .first(),
});

export const recordTest = internalMutation({
  args: { result: v.object({ id: v.id('pushSubscriptions'), ok: v.boolean(), gone: v.boolean(), error: v.optional(v.string()) }) },
  handler: async (ctx, args) => await recordResults(ctx, [args.result]),
});

/** Test notification to this device, immediately and even while the app is open. */
export const sendTest = ownerAction({
  args: { endpoint: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error: string | null }> => {
    let vapid: VapidKeys | null;
    try {
      vapid = vapidForSending();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!vapid) return { ok: false, error: 'Push is not set up on the server (VAPID key missing).' };
    const sub = await ctx.runQuery(internal.push.subscriptionByEndpoint, { endpoint: args.endpoint });
    if (!sub) return { ok: false, error: 'This device is not registered.' };
    const message: PushMessage = {
      title: 'Selfbound',
      body: pushText('Test notification: notifications work on this device.'),
      url: '/settings/notifications',
      tag: 'test',
      at: Date.now(),
      test: true,
    };
    const result = await send({ id: sub._id, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, message, vapid);
    await ctx.runMutation(internal.push.recordTest, { result });
    return { ok: result.ok, error: result.ok ? null : (result.error ?? 'Error') };
  },
});
