<script lang="ts">
  // Sprint view header: inline goal, points done/total, issues, capacity, share added late, date
  // range. The core computes the numbers (app.sprints.active).
  import { ICON } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { points } from '@selfbound/core/sprintlogic';
  import Goal from './Goal.svelte';

  const activeSlice = fromSlice(app.sprints.active);
  const editingSlice = fromSlice(app.sprints.editing);
  const editing = $derived(editingSlice.current);
  const s = $derived(activeSlice.current);
  const tot = $derived(s?.totals);
  const pct = $derived(tot && tot.points ? Math.round((tot.donePoints / tot.points) * 100) : 0);
  const load = $derived(s && s.capacity ? Math.round(((tot?.points ?? 0) / s.capacity) * 100) : null);
</script>

{#if s && tot}
  <section class="sprint-head" data-testid="sprint-head">
    <div class="sprint-head-row">
      <Goal sprintId={s.id} goal={s.goal} />
      <button class={['icon-btn', editing && 'on']} title={t('Edit sprint')} aria-label={t('Edit sprint')} aria-pressed={editing} data-testid="sprint-edit" onclick={() => app.sprints.editing.set(!editing)}>
        <span class="icon">{@html ICON.edit}</span>
      </button>
    </div>
    {#if editing}
      <div class="sprint-edit" data-testid="sprint-edit-form">
        <label>{t('Name')} <input class="input" data-testid="sprint-edit-name" value={s.name} onchange={(e) => app.sprints.update(s.id, { name: e.currentTarget.value })} /></label>
        <label>{t('Start')} <input class="input" type="date" data-testid="sprint-edit-start" value={s.startDate} onchange={(e) => app.sprints.update(s.id, { startDate: e.currentTarget.value })} /></label>
        <label>{t('End')} <input class="input" type="date" data-testid="sprint-edit-end" value={s.endDate} onchange={(e) => app.sprints.update(s.id, { endDate: e.currentTarget.value })} /></label>
        <label>{t('Capacity')} <input class="input num" inputmode="decimal" data-testid="sprint-edit-capacity" value={s.capacity !== null ? points(s.capacity) : ''} onchange={(e) => app.sprints.setCapacity(s.id, e.currentTarget.value)} /> {t('points')}</label>
        <button class="btn small" data-testid="sprint-edit-done" onclick={() => app.sprints.editing.set(false)}>{tc('button', 'Done')}</button>
      </div>
    {/if}
    <div class="sprint-stats">
      <div class="stat wide" title={t('{pct} % of the points done', { pct })}>
        <span class="stat-label">{t('Progress')}</span>
        <span class="stat-value" data-testid="sprint-points"><b>{points(tot.donePoints)}</b> / {points(tot.points)} {t('points')}</span>
        <span class="progress big"><div style:width="{pct}%"></div></span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Issues')}</span>
        <span class="stat-value" data-testid="sprint-issues"><b>{tot.done}</b> / {tot.issues} {t('done')}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Capacity')}</span>
        <span class="stat-value">{#if s.capacity !== null}{points(s.capacity)} {t('points')}{#if load !== null}<span class={['stat-sub sep', load > 100 && 'warn']}>{t('{pct} % planned', { pct: load })}</span>{/if}{:else}<span class="stat-sub">{t('not set')}</span>{/if}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Added late')}</span>
        <span class={['stat-value', tot.late > 0 && 'late']} data-testid="sprint-late">{tot.late} · {tot.lateShare} %</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Date range')}</span>
        <span class="stat-value">{s.range}<span class="stat-sub sep">{s.remaining}</span></span>
      </div>
    </div>
  </section>
{/if}
