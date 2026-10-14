<script lang="ts">
  // Notifications: push on this device on and off, test notification, events (apply to all
  // devices) and the list of registered devices. New events show up by themselves
  // (backend/convex/shared/notifyEvents.ts).
  import { relativeTime } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { api } from '@selfbound/backend/api';
  import type { Id } from '@selfbound/backend/dataModel';
  import { NOTIFY_EVENTS, type NotifyKind } from '@selfbound/backend/shared/notifyEvents';
  import { app } from '../../app-instance.ts';
  import { useQuery } from '../../lib/live.svelte.ts';
  import { currentSubscription, disablePush, enablePush, pushSupport } from '../../lib/pwa/push.ts';

  const config = useQuery(api.push.config, {});
  const support = pushSupport();
  const installed = globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
  const android = /Android/.test(navigator.userAgent);
  let permission = $state<NotificationPermission>(support === 'ok' ? Notification.permission : 'default');
  let endpoint = $state<string | null | undefined>(undefined);
  let busy = $state(false);
  let testing = $state(false);

  void currentSubscription().then((s) => (endpoint = s?.endpoint ?? null));

  const devices = $derived([...(config.current?.devices ?? [])].sort((a, b) => Number(b.endpoint === endpoint) - Number(a.endpoint === endpoint) || b.createdAt - a.createdAt));
  const here = $derived(devices.find((d) => d.endpoint === endpoint) ?? null);
  const on = $derived(here !== null && permission === 'granted');
  const configured = $derived(config.current?.publicKey != null);
  const hour = $derived(config.current?.morningHour ?? 8);

  async function setOn(value: boolean) {
    if (busy || value === on) return;
    busy = true;
    try {
      if (value) {
        const key = config.current?.publicKey;
        if (!key) return;
        const result = await enablePush(app, key);
        permission = Notification.permission;
        if (result === 'denied') app.toasts.show(t('Notifications blocked'), undefined, 'error', t('Allow them in the browser’s site settings.'));
        else app.cues.emit('toggleOn');
      } else {
        await disablePush(app);
        app.cues.emit('toggleOff');
      }
      endpoint = (await currentSubscription())?.endpoint ?? null;
    } catch (error) {
      app.toasts.error(value ? t('Not turned on') : t('Not turned off'), error);
    } finally {
      busy = false;
    }
  }

  async function sendTest() {
    if (!endpoint || testing) return;
    testing = true;
    try {
      const result = await app.store.client.action(api.push.sendTest, { endpoint });
      if (result.ok) app.toasts.show(t('Test notification sent'));
      else app.toasts.show(t('Test notification not sent'), undefined, 'error', result.error ?? undefined);
    } catch (error) {
      app.toasts.error(t('Test notification not sent'), error);
    } finally {
      testing = false;
    }
  }

  function setEvent(kind: NotifyKind, enabled: boolean) {
    app.store.call(api.push.setEvent, { kind, enabled }).catch((error: unknown) => app.toasts.error(t('Not saved'), error));
  }

  function remove(id: Id<'pushSubscriptions'>, name: string) {
    app.store
      .call(api.push.removeDevice, { id })
      .then(() => app.toasts.show(t('{name} removed', { name })))
      .catch((error: unknown) => app.toasts.error(t('Not removed'), error));
  }
</script>

<h1 class="page-title">{t('Notifications')}</h1>
<p class="page-lead">{t('Notifications on phone and desktop, even when Selfbound is closed. While you are using Selfbound on a device, nothing goes to the phone: the notification shows up in the app instead.')}</p>

<h2 class="section-title">{t('This device')}</h2>
<div class="card-list" data-testid="push-device">
  <div class="card-row">
    <span class="t">{t('Notifications on this device')}
      <div class="sub" data-testid="push-status">
        {#if support === 'insecure'}
          {t('Only possible over https.')}
        {:else if support === 'unsupported'}
          {t('This browser cannot receive push notifications.')}
        {:else if config.current === undefined}
          {t('Loading …')}
        {:else if !configured}
          {t('Not set up on the server (VAPID key missing, see docs/operations.md).')}
        {:else if permission === 'denied'}
          {t('Blocked in the browser. Allow notifications for this page in the site settings.')}
        {:else if on}
          {t('On')}{here ? ` · ${here.device}` : ''}
        {:else}
          {t('Off')}
        {/if}
      </div>
    </span>
    <span class="seg" data-testid="push-switch">
      <button class={[on && 'on']} disabled={busy || support !== 'ok' || !configured || permission === 'denied'} onclick={() => void setOn(true)}>{t('On')}</button><button class={[!on && 'on']} disabled={busy || !on} onclick={() => void setOn(false)}>{t('Off')}</button>
    </span>
  </div>
  <div class="card-row">
    <span class="t">{t('Test notification')}<div class="sub">{t('Arrives on this device right away, even while Selfbound is open.')}</div></span>
    <button class="btn small" data-testid="push-test" disabled={!on || testing} onclick={() => void sendTest()}>{t('Send')}</button>
  </div>
  {#if android && !installed}
    <div class="card-row">
      <span class="t">{t('Install as an app')}<div class="sub">{t('In Chrome, choose "Install app" in the ⋮ menu. Selfbound then starts full screen from the home screen, and "Share" from other apps creates issues in the inbox.')}</div></span>
    </div>
  {/if}
</div>

<h2 class="section-title">{t('Events')}</h2>
<p class="section-lead">{t('Applies to all devices. Several events at once arrive as one notification.')}</p>
<div class="card-list" data-testid="push-events">
  {#each NOTIFY_EVENTS as event (event.id)}
    {@const enabled = config.current?.events[event.id] ?? event.default}
    <div class="card-row" data-testid="push-event" data-kind={event.id}>
      <span class="t">{t(event.label)}<div class="sub">{event.id === 'due' || event.id === 'sprint_end' || event.id === 'snooze' ? `${t(event.hint)} ${t('At {hour}:00.', { hour })}` : t(event.hint)}</div></span>
      <span class="seg">
        <button class={[enabled && 'on']} disabled={config.current === undefined} onclick={() => setEvent(event.id, true)}>{t('On')}</button><button class={[!enabled && 'on']} disabled={config.current === undefined} onclick={() => setEvent(event.id, false)}>{t('Off')}</button>
      </span>
    </div>
  {/each}
</div>

<h2 class="section-title">{t('Devices')}</h2>
<div class="card-list" data-testid="push-devices">
  {#if config.current === undefined}
    <div class="card-row muted">{t('Loading …')}</div>
  {:else if devices.length === 0}
    <div class="card-row muted">{t('No device registered yet.')}</div>
  {/if}
  {#each devices as d (d.id)}
    <div class="card-row" data-testid="push-device-row">
      <span class="t">{d.device}{#if d.endpoint === endpoint}<span class="state-badge" style="margin-left: 8px">{t('this device')}</span>{/if}
        <div class="sub">{t('registered {time}', { time: relativeTime(d.createdAt) })} · {d.lastSentAt ? t('last notified {time}', { time: relativeTime(d.lastSentAt) }) : t('no notification yet')}{#if d.failures > 0} · <span title={d.lastError ?? ''}>{tn(d.failures, '{count} failed attempt', '{count} failed attempts')}</span>{/if}</div>
      </span>
      <button class="btn ghost small danger" onclick={() => (d.endpoint === endpoint ? void setOn(false) : remove(d.id, d.device))}>{t('Remove')}</button>
    </div>
  {/each}
</div>
