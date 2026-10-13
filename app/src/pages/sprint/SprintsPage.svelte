<script lang="ts">
  import '../../styles/sprint.css';
  // All sprints: active, planning, closed (cycles imported from Linear are marked) with goal, date
  // range, points done/planned and share added late.
  import { ICON, type SprintId } from '@xlr8/core';
  import { t, tn, translated } from '@xlr8/core/i18n';
  import { points } from '@xlr8/core/sprintlogic';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';

  const rowsSlice = fromSlice(app.sprints.rows);
  const rows = $derived(rowsSlice.current);
  const STATE = translated({ active: 'Running', planning: 'In planning', closed: 'Finished' });

  function open(row: { id: SprintId; number: number; state: string }) {
    if (row.state === 'active') app.nav.goView({ kind: 'sprint', team: null });
    else if (row.state === 'planning') app.nav.goView({ kind: 'plan', team: null, sprint: String(row.number) });
    else app.nav.goView({ kind: 'all', team: null }, { filters: { status: [], priority: [], team: [], label: [], project: [], sprint: [row.id], unreviewed: false }, group: 'status' });
  }
</script>

<header class="location-bar" data-testid="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs"><span class="crumb"><span class="icon">{@html ICON.sprint}</span><span class="crumb-title" data-testid="view-title">{t('Sprints')}</span></span></div>
  <span class="bar-spacer"></span>
  <button class="btn small" onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: null })}><span class="icon">{@html ICON.plus}</span>{t('Plan sprint')}</button>
</header>
<div class="page" data-testid="sprints-page">
  <div class="page-content wide">
    {#if rows === null}
      <div class="skeleton-bar" style="width: 40%; margin: 24px 0"></div>
    {:else if rows.length === 0}
      <div class="empty">
        <div class="empty-icon"><span class="icon">{@html ICON.sprint}</span></div>
        <div class="empty-text">{t('No sprints yet. Plan the first one: set a goal, pick issues from all teams, start.')}</div>
        <button class="btn primary" onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: null })}>{t('Plan sprint')}</button>
      </div>
    {:else}
      <div class="card-list sprint-list">
        <div class="card-row head">
          <span class="t">{t('Sprint')}</span><span class="c-range">{t('Date range')}</span><span class="c-num">{t('Points done / planned')}</span><span class="c-num">{t('Added late')}</span>
        </div>
        {#each rows as row (row.id)}
          {@const st = row.stats}
          <a class="card-row" data-testid="sprint-row" data-state={row.state} data-number={row.number} href="/sprints" onclick={(e) => { e.preventDefault(); open(row); }}>
            <span class="t">
              <span class="sprint-name">{row.name}<span class={['state-badge', row.state]}>{STATE[row.state]}</span>{#if row.source === 'linear'}<span class="state-badge linear" title={t('Cycle imported from Linear')}>Linear</span>{/if}</span>
              <div class="sub">{row.goal || t('No goal')}</div>
            </span>
            <span class="c-range">{row.range}<div class="sub">{row.remaining}</div></span>
            <span class="c-num">{#if st}<b>{points(st.donePoints)}</b> / {points(st.points)}<div class="sub">{tn(st.issues, '{count} issue', '{count} issues')}{st.carried ? ` · ${t('{count} carried over', { count: st.carried })}` : ''}</div>{:else}…{/if}</span>
            <span class="c-num">{#if st}{st.late} · {st.lateShare} %{:else}…{/if}</span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
</div>
