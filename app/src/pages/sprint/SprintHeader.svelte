<script lang="ts">
  // Sprint view header: inline goal, points done/total, issues, capacity, share added late, date
  // range. The core computes the numbers (app.sprints.active).
  import { t } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { points } from '@xlr8/core/sprintlogic';
  import Goal from './Goal.svelte';

  const activeSlice = fromSlice(app.sprints.active);
  const s = $derived(activeSlice.current);
  const tot = $derived(s?.totals);
  const pct = $derived(tot && tot.points ? Math.round((tot.donePoints / tot.points) * 100) : 0);
  const load = $derived(s && s.capacity ? Math.round(((tot?.points ?? 0) / s.capacity) * 100) : null);
</script>

{#if s && tot}
  <section class="sprint-head" data-testid="sprint-head">
    <Goal sprintId={s.id} goal={s.goal} />
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
