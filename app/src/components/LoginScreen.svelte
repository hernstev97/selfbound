<script lang="ts">
  // Notices instead of the app: not set up, no access, signed out (only with the test sign-in;
  // with Clerk it goes straight to the sign-in page /sign-in), no connection on first start.
  import { t } from '@selfbound/core/i18n';
  import { auth } from '../app-instance.ts';
  import Logo from './Logo.svelte';

  let { reason }: { reason: 'signin' | 'config' | 'denied' | 'offline' } = $props();
  let retrying = $state(false);
  // Split around the placeholder so the command renders as <code>.
  const local = t('Locally, {command} starts everything.', { command: '\u0000' }).split('\u0000');

  async function retry() {
    retrying = true;
    await auth.retry();
    retrying = false;
  }
</script>

<div class="login" data-testid="login">
  <div class="login-card">
    <div class="login-logo"><Logo kind="lockup" height={32} /></div>
    {#if reason === 'config'}
      <h1>{t('Selfbound is not set up')}</h1>
      <p>{t('The backend address (VITE_CONVEX_URL) or a sign-in method is missing.')} {local[0]}<code>node tooling/local.mjs</code>{local[1]}</p>
    {:else if reason === 'denied'}
      <h1>{t('No access')}</h1>
      <p>{t('You are signed in, but this account has no access to Selfbound.')}</p>
      <button class="btn primary login-button" onclick={() => void auth.signOut()}>{t('Sign out')}</button>
    {:else if reason === 'offline'}
      <h1>{t('No connection')}</h1>
      <p>{t('Selfbound needs the network to sign in. This device has no saved data yet that it could show offline.')}</p>
      <button class="btn primary login-button" data-testid="offline-retry" disabled={retrying} onclick={() => void retry()}>{retrying ? t('Connecting …') : t('Try again')}</button>
    {:else}
      <h1>{t('Sign in to Selfbound')}</h1>
      <p>{t('Sign-in through Clerk.')}</p>
      <button class="btn primary login-button" data-testid="login-button" onclick={() => void auth.signIn()}>{t('Sign in')}</button>
    {/if}
  </div>
</div>
