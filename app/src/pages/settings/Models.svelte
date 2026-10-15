<script lang="ts">
  // Models (XLR8-93): which models of the models.dev catalog the issue chip offers. The backend syncs
  // the catalog daily (the browser never contacts models.dev); here the owner enables models by
  // provider or by search. Disabling a model keeps it on the issues that use it.
  import { api } from '@selfbound/backend/api';
  import { ICON, relativeTime, type ModelInfo } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { useQuery } from '../../lib/live.svelte.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import CatalogModels from './CatalogModels.svelte';
  import ModelRow from './ModelRow.svelte';
  import { admin } from './admin.ts';

  const metaSlice = fromSlice(app.store.meta);
  const enabled = $derived(metaSlice.current?.models ?? []);
  const catalog = useQuery(api.models.catalog, {});
  const providers = $derived(catalog.current?.providers ?? []);
  const status = $derived(catalog.current?.status ?? null);
  const enabledPer = $derived.by(() => {
    const n = new Map<string, number>();
    for (const m of enabled) n.set(m.provider, (n.get(m.provider) ?? 0) + 1);
    return n;
  });

  let provider = $state('');
  let query = $state('');
  // The search across providers asks the server; wait until typing pauses.
  let searched = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  function onQuery(value: string) {
    query = value;
    clearTimeout(timer);
    timer = setTimeout(() => (searched = value.trim()), 200);
  }
  $effect(() => () => clearTimeout(timer));

  const toggle = (m: ModelInfo, on: boolean) => void admin.setModelEnabled(m, on);
</script>

<h1 class="page-title">{t('Models')}</h1>
<p class="page-lead">{t('The models you use for issues. Only these appear in the model chip, and agents see them with list_models. The catalog comes from models.dev; the server updates it daily.')}</p>

<h2 class="section-title">{t('Enabled')}</h2>
<div class="card-list" data-testid="models-enabled">
  {#each enabled as model (`${model.provider}/${model.modelId}`)}
    <ModelRow {model} showProvider on={toggle} />
  {:else}
    <div class="card-row muted">{t('No models enabled yet. Choose a provider or search below.')}</div>
  {/each}
</div>

<h2 class="section-title">{t('Catalog')}</h2>
<div class="card-list">
  <div class="card-row" data-testid="models-status">
    <span class="t"
      >{#if status?.syncedAt}{t('Catalog updated {when}', { when: relativeTime(status.syncedAt) })}{:else if catalog.current}{t('Not loaded yet')}{:else}{t('Loading …')}{/if}
      <div class="sub">
        {#if status?.models}{t('{models} models from {providers} providers', { models: status.models, providers: status.providers ?? 0 })}{/if}
        {#if status && !status.ok && status.error}<span class="warn-text" data-testid="models-error">{t('Last check failed: {error}', { error: status.error })}</span>{/if}
      </div></span
    >
    <button class="btn small" data-testid="models-refresh" onclick={() => void admin.refreshModels().then((r) => r && app.toasts.show(r.scheduled ? t('Updating the catalog …') : t('The catalog was checked a moment ago.')))}><span class="icon">{@html ICON.restore}</span>{t('Update now')}</button>
  </div>
</div>

<div class="model-browse">
  <span class="dp-select">
    <select aria-label={t('Provider')} data-testid="models-provider" bind:value={provider}>
      <option value="">{t('All providers')}</option>
      {#each providers as p (p.provider)}<option value={p.provider}>{p.name} ({p.count}){enabledPer.get(p.provider) ? ` · ${tn(enabledPer.get(p.provider)!, '{count} enabled', '{count} enabled')}` : ''}</option>{/each}
    </select>
    <span class="icon">{@html ICON.chevronDown}</span>
  </span>
  <input class="input grow" type="search" placeholder={provider ? t('Filter models …') : t('Search models in all providers …')} aria-label={t('Search models')} data-testid="models-search" value={query} oninput={(e) => onQuery(e.currentTarget.value)} />
</div>

{#if provider}
  {#key provider}<CatalogModels {provider} filter={query} on={toggle} />{/key}
{:else if searched.length >= 2}
  {#key searched}<CatalogModels q={searched} on={toggle} />{/key}
{:else}
  <p class="section-lead">{t('Choose a provider, or type at least two letters to search all providers.')}</p>
{/if}

<style>
  .model-browse {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 20px 0 10px;
  }
  .warn-text {
    color: var(--warning-text);
  }
</style>
