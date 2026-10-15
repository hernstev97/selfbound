<script lang="ts">
  // Catalog models of one provider (newest first, filtered locally) or the hits of a search across all
  // providers. Keyed by the parent, so each provider or search is its own subscription.
  import { api } from '@selfbound/backend/api';
  import type { ModelInfo } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { useQuery } from '../../lib/live.svelte.ts';
  import ModelRow from './ModelRow.svelte';

  let { provider, q, filter = '', on }: { provider?: string; q?: string; filter?: string; on: (model: ModelInfo, enabled: boolean) => void } = $props();
  // svelte-ignore state_referenced_locally
  const result = provider ? useQuery(api.models.list, { provider }) : useQuery(api.models.search, { q: q ?? '', limit: 30 });
  const shown = $derived.by(() => {
    const all = result.current ?? [];
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((m) => words.every((w) => `${m.name} ${m.modelId} ${m.family ?? ''}`.toLowerCase().includes(w))) : all;
  });
</script>

<div class="card-list" data-testid="models-catalog">
  {#if result.current === undefined}
    <div class="card-row muted">{t('Loading …')}</div>
  {:else}
    {#each shown as model (`${model.provider}/${model.modelId}`)}
      <ModelRow {model} showProvider={!provider} {on} />
    {:else}
      <div class="card-row muted">{t('No models found.')}</div>
    {/each}
  {/if}
</div>
