<script lang="ts">
  // Empty state: one sentence on why, exactly one action.
  import { t } from '@xlr8/core/i18n';
  import { ICON, VIEWS } from '@xlr8/core';
  import type { ListController } from '@xlr8/core/app/list';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  let { reason, list = app.main }: { reason: 'filtered' | 'none'; list?: ListController } = $props();
  // svelte-ignore state_referenced_locally
  const viewSlice = fromSlice(list.view);
  const metaSlice = fromSlice(app.store.meta);
  const def = $derived(VIEWS[viewSlice.current.route.kind]);
  const noSprint = $derived(def.kind === 'sprint' && !metaSlice.current?.sprints.some((s) => s.state === 'active'));
  const canCreate = $derived(!['inbox', 'trash', 'close', 'plan', 'planned'].includes(def.kind));
</script>

<div class="empty" data-testid="empty-state">
  <div class="empty-icon"><span class="icon">{@html ICON[def.icon]}</span></div>
  {#if reason === 'filtered'}
    <div class="empty-text">{t('No issues match these filters.')}</div>
    <button class="btn" data-testid="empty-reset" onclick={() => list.clearFilters()}>{t('Reset filters')}</button>
  {:else if noSprint}
    <div class="empty-text">{def.emptyText}</div>
    <button class="btn primary" data-testid="empty-plan" onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: null })}>{t('Plan sprint')}</button>
  {:else if def.kind === 'sprint'}
    <div class="empty-text">{t('This sprint has no issues yet.')}</div>
    <button class="btn" data-testid="empty-create" onclick={() => app.create.open()}>{t('Create issue')} <span class="kbd">C</span></button>
  {:else}
    <div class="empty-text">{def.emptyText}</div>
    {#if canCreate}
      <button class="btn" data-testid="empty-create" onclick={() => app.create.open()}>{t('Create issue')} <span class="kbd">C</span></button>
    {/if}
  {/if}
</div>
