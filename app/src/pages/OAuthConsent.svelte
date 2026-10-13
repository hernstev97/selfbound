<script lang="ts">
  // Consent for a connector (claude.ai, ChatGPT): /oauth/consent?request=… (older links:
  // /oauth/freigabe?anfrage=…). The backend's /oauth/authorize redirects here. Only the owner can
  // read the request (owner functions). The server builds the redirect back to the app (with code or
  // error); the page takes nothing from its own URL except the request id.
  import type { FunctionReturnType } from 'convex/server';
  import '../styles/forms.css';
  import { api } from '@xlr8/backend/api';
  import { relativeTime } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { auth, client } from '../app-instance.ts';
  import Logo from '../components/Logo.svelte';

  type View = FunctionReturnType<typeof api.oauth.request>;

  const params = new URL(location.href).searchParams;
  const requestId = params.get('request') ?? params.get('anfrage') ?? '';
  let view = $state<View | undefined>(undefined);
  let loadError = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let name = $state('');
  let busy = $state(false);
  let leaving = $state<string | null>(null);
  let now = $state(Date.now());
  // "Allow" only after one second: no accidental confirmation by Enter or double click.
  let ready = $state(false);

  const message = (e: unknown) => {
    const data = (e as { data?: { message?: unknown } } | null)?.data;
    return typeof data?.message === 'string' ? data.message : t('Unknown error. Please reload the page.');
  };

  $effect(() => {
    if (!requestId) {
      loadError = t('The address has no request.');
      return;
    }
    const stop = client.onUpdate(
      api.oauth.request,
      { request: requestId },
      (v) => {
        if (view === undefined && v.state !== 'unknown') name = v.suggestedName;
        view = v;
      },
      (e) => (loadError = message(e)),
    );
    const tick = setInterval(() => (now = Date.now()), 1000);
    const arm = setTimeout(() => (ready = true), 1000);
    return () => {
      stop();
      clearInterval(tick);
      clearTimeout(arm);
    };
  });

  const pending = $derived(view !== undefined && view.state === 'pending' ? view : null);
  const expired = $derived(pending !== null && pending.expiresAt <= now);
  const armed = $derived(pending !== null && (pending.armedUntil ?? 0) > now);

  async function decide(approve: boolean) {
    if (busy || !pending) return;
    busy = true;
    actionError = null;
    try {
      const { redirect } = await client.action(api.oauth.decide, { request: requestId, approve, ...(approve ? { name: name.trim() } : {}) });
      leaving = pending.redirectHost;
      location.assign(redirect);
    } catch (e) {
      actionError = message(e);
      busy = false;
    }
  }
</script>

<div class="login consent" data-testid="oauth-consent">
  <div class="login-card">
    <div class="login-logo"><Logo kind="full" height={36} /></div>
    {#if loadError}
      <h1>{t('No access')}</h1>
      <p>{loadError}</p>
      <button class="btn ghost login-button" onclick={() => void auth.signOut()}>{t('Sign out')}</button>
    {:else if view === undefined}
      <p>{t('Loading …')}</p>
    {:else if leaving}
      <h1>{t('Continuing to {host} …', { host: leaving })}</h1>
    {:else if view.state === 'unknown'}
      <h1>{t('Unknown request')}</h1>
      <p data-testid="oauth-unknown">{t('This request does not exist (any more). Start the connection again in the app.')}</p>
    {:else if !pending}
      <h1>{t('Already done')}</h1>
      <p data-testid="oauth-done">{t('This request has already been answered. You can close this window.')}</p>
    {:else if expired}
      <h1>{t('Request expired')}</h1>
      <p data-testid="oauth-expired">{t('Start the connection again in {app}.', { app: pending.appName })}</p>
    {:else}
      <h1>{t('Connect {app} to XLR8?', { app: pending.appName })}</h1>
      <p>
        {pending.clientName && pending.clientName !== pending.appName
          ? t('{app} ("{client}") wants to access XLR8 as a connector.', { app: pending.appName, client: pending.clientName })
          : t('{app} wants to access XLR8 as a connector.', { app: pending.appName })}
        {t('It may do everything an agent may do: search, read, create, change and comment on issues.')}
      </p>
      <div class="facts">
        <div><span>{t('Returns to')}</span><b class="mono" data-testid="oauth-host">{pending.redirectHost}</b></div>
        <div><span>{t('Requested')}</span><b>{relativeTime(pending.createdAt)}</b></div>
      </div>
      <label class="field">
        <span>{t('Name in the history')}</span>
        <input class="input" data-testid="oauth-name" maxlength="60" bind:value={name} />
      </label>
      <p class="warn">{t('Only allow this if you just started the connection yourself in {app}.', { app: pending.appName })}</p>
      {#if !armed}
        <p class="warn strong" data-testid="oauth-not-armed">
          {t('XLR8 is not accepting new connectors right now. In another tab, press "Connect connector" under Settings → Agents, then press "Allow" here.')}
        </p>
      {/if}
      {#if actionError}<p class="warn strong" data-testid="oauth-error">{actionError}</p>{/if}
      <div class="actions">
        <button class="btn ghost" data-testid="oauth-deny" disabled={busy} onclick={() => void decide(false)}>{t('Deny')}</button>
        <button class="btn primary" data-testid="oauth-approve" disabled={busy || !ready || !armed || !name.trim()} onclick={() => void decide(true)}>{t('Allow')}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .consent .login-card {
    width: 420px;
    text-align: left;
  }
  .consent h1,
  .consent .login-logo {
    text-align: center;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin: 0 0 16px;
    font-size: var(--fs-small, 13px);
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
  .facts span {
    color: var(--text-muted);
  }
  .facts b {
    font-weight: 510;
    color: var(--text-strong);
  }
  .field {
    display: grid;
    gap: 6px;
    margin: 0 0 16px;
  }
  .field span {
    color: var(--text-muted);
    font-size: var(--fs-small, 13px);
  }
  .consent p.warn {
    margin: 0 0 12px;
    font-size: var(--fs-small, 13px);
  }
  .consent p.warn.strong {
    color: var(--text-strong);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
  }
</style>
