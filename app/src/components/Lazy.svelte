<script lang="ts" generics="M">
  // Lazily loaded part (its own chunk) with an error state: if loading fails (no network, a new
  // version was deployed), a notice with "Try again" replaces the empty area. Back online, it
  // retries on its own. `pages.ts` forgets failed attempts.
  //
  // Without `children` it shows the module's `default` (with `props`), otherwise the snippet with the module.
  // `quiet`: small parts (bar, header, peek) show nothing on failure but reload once online.
  import type { Component, Snippet } from 'svelte';
  import { t } from '@selfbound/core/i18n';

  let {
    load,
    props = {},
    pending,
    children,
    quiet = false,
  }: { load: () => Promise<M>; props?: Record<string, unknown>; pending?: Snippet; children?: Snippet<[M]>; quiet?: boolean } = $props();

  let attempt = $state(0);
  // The same promise as long as nothing fails: a loaded part appears without flicker.
  const module = $derived.by(() => {
    void attempt;
    return load();
  });

  function retry() {
    attempt++;
  }

  /** Listen for "online" only after a failure, so mounting costs nothing otherwise. */
  function retryOnline() {
    addEventListener('online', retry);
    return () => removeEventListener('online', retry);
  }
</script>

{#await module}
  {@render pending?.()}
{:then m}
  {#if children}
    {@render children(m)}
  {:else}
    {@const Default = (m as { default: Component<Record<string, unknown>> }).default}
    <Default {...props} />
  {/if}
{:catch}
  {#if quiet}
    <span hidden {@attach retryOnline}></span>
  {:else}
    <div class="load-failed" role="alert" data-testid="load-failed" {@attach retryOnline}>
      <p>{navigator.onLine ? t('This part could not be loaded.') : t('Offline: this part is not loaded on this device yet.')}</p>
      <button class="btn" data-testid="load-retry" onclick={retry}>{t('Try again')}</button>
    </div>
  {/if}
{/await}

<style>
  .load-failed {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    margin: 64px auto 0;
    max-width: 360px;
    text-align: center;
    color: var(--text-muted);
  }
  .load-failed p {
    margin: 0;
  }
</style>
