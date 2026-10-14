<script lang="ts">
  // Buttons in the location bar of the sprint view: all sprints, plan, close.
  import { ICON } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';

  const metaSlice = fromSlice(app.store.meta);
  const active = $derived(metaSlice.current?.sprints.find((s) => s.state === 'active') ?? null);
  const planning = $derived(metaSlice.current?.sprints.some((s) => s.state === 'planning') ?? false);
</script>

<button class="btn ghost small desktop-only" data-testid="sprint-all" onclick={() => app.nav.go({ name: 'sprints' })}>{t('All sprints')}</button>
<button class="btn small" title={t('Plan sprint')} data-testid="sprint-plan" onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: null })}>
  <span class="icon">{@html ICON.sprint}</span><span class="btn-label">{planning ? t('Plan next') : t('Plan sprint')}</span>
</button>
{#if active}
  <button class="btn small" title={t('Close sprint')} data-testid="sprint-close" onclick={() => app.nav.goView({ kind: 'close', team: null })}><span class="icon">{@html ICON.check}</span><span class="btn-label">{tc('sprint', 'Close')}</span></button>
{/if}
