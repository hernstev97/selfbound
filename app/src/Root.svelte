<script lang="ts">
  import { isConsentPath } from '@selfbound/core';
  import { auth, convexUrl } from './app-instance.ts';
  import { fromSlice } from './slice.svelte.ts';
  import Shell from './components/Shell.svelte';
  import LoginScreen from './components/LoginScreen.svelte';
  import Logo from './components/Logo.svelte';

  const status = fromSlice(auth.status);
  const unreachable = fromSlice(auth.unreachable);
  // Consent page for connectors: its own lazily loaded part without the app shell.
  const consent = isConsentPath(location.pathname);
</script>

{#if !convexUrl}
  <LoginScreen reason="config" />
{:else if status.current === 'signed-in' || (status.current === 'cached' && !consent)}
  {#if consent}
    {#await import('./pages/OAuthConsent.svelte') then { default: Consent }}
      <Consent />
    {/await}
  {:else}
    <Shell />
  {/if}
{:else if status.current === 'cached' && unreachable.current}
  <!-- Consent page without network: it needs the sign-in, the cache does not help it. -->
  <LoginScreen reason="offline" />
{:else if status.current === 'loading' || status.current === 'cached' || (status.current === 'signed-out' && auth.kind === 'clerk')}
  <!-- Signed out with Clerk: continues straight to the sign-in page (main.ts) -->
  <div class="login" data-testid="loading"><Logo kind="symbol" height={40} /></div>
{:else}
  <LoginScreen reason={status.current === 'unconfigured' ? 'config' : status.current === 'denied' ? 'denied' : status.current === 'offline' ? 'offline' : 'signin'} />
{/if}
