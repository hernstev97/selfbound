<script lang="ts">
  // Placeholder of the detail page while the chunk or the data is missing (e.g. a deep link on a slow
  // network): header with the identifier from the URL, below it title and text bars.
  // Small and without dependencies so it may live in the start bundle.
  import { ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  let { header = true }: { header?: boolean } = $props();
  const pageSlice = fromSlice(app.nav.page);
  const syncSlice = fromSlice(app.store.sync);
  const key = $derived(pageSlice.current.name === 'issue' ? pageSlice.current.key : '');
</script>

{#if header}
  <header class="location-bar" data-testid="location-bar">
    <button class="icon-btn plain mobile-only" aria-label={t('Back')} onclick={() => app.closeIssue()}><span class="icon">{@html ICON.back}</span></button>
    <div class="crumbs"><span class="crumb"><span class="crumb-title tnum" data-testid="detail-skeleton-key">{key}</span></span></div>
  </header>
{/if}
<div class="detail-skeleton" data-testid="detail-loading" aria-busy="true" aria-label={t('Loading {key}', { key })}>
  {#if syncSlice.current.offline}
    <!-- Offline and not in the cache: otherwise the placeholder would stay without explanation. -->
    <p class="offline-note" role="status" data-testid="detail-offline">{key ? t('Offline. {key} is not on this device; it appears once the network is back.', { key }) : t('Offline. This issue is not on this device; it appears once the network is back.')}</p>
  {/if}
  <div class="skeleton-bar title"></div>
  <div class="skeleton-bar" style="width: 92%"></div>
  <div class="skeleton-bar" style="width: 84%"></div>
  <div class="skeleton-bar" style="width: 61%"></div>
</div>

<style>
  .detail-skeleton {
    display: flex;
    flex-direction: column;
    gap: 14px;
    width: min(720px, 100% - 48px);
    margin: 40px auto 0;
  }
  .detail-skeleton .offline-note {
    margin: 0 0 6px;
  }
  .title {
    width: 46%;
    height: 18px;
    margin-bottom: 10px;
  }
</style>
