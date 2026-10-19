<script lang="ts">
  import '../../styles/sprint.css';
  // Sprint planning: on the left the ordered backlog across all active teams, on the right the sprint
  // with its point total against the capacity, goal and date range on top. Both columns are normal
  // lists (app.main / app.side): J/K, X, S, P, Space, Enter work as everywhere, → plans in,
  // ← sends back, Tab switches the column, Alt ↑/↓ and dragging reorder.
  import { ICON, PRIORITY_ICON } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { points } from '@selfbound/core/sprintlogic';
  import { pages } from '../../lib/pages.ts';
  import Lazy from '../../components/Lazy.svelte';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { tip } from '../../lib/ui.ts';
  import ListView from '../../components/ListView.svelte';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import Goal from './Goal.svelte';

  const planSlice = fromSlice(app.sprints.plan);
  const mainHead = fromSlice(app.main.header);
  const sideHead = fromSlice(app.side.header);
  const paneSlice = fromSlice(app.pane);
  const shellSlice = fromSlice(app.shell);
  const displayOpen = fromSlice(app.displayOpen);
  const plan = $derived(planSlice.current);
  const s = $derived(plan?.sprint ?? null);
  const capacity = $derived(s?.capacity ?? null);
  // Without a set capacity, the suggestion from recent sprints applies (the field shows it too).
  const suggested = $derived(plan?.suggestion?.capacity ?? null);
  const effective = $derived(capacity ?? suggested);
  const load = $derived(s && effective ? Math.min(100, Math.round((s.totals.points / effective) * 100)) : 0);
  const over = $derived(!!s && effective !== null && s.totals.points > effective);

  // New sprint (form, when none is in planning)
  let name = $state('');
  let startDate = $state('');
  let endDate = $state('');
  let goal = $state('');
  let creating = $state(false);
  $effect(() => {
    if (plan && !s && !startDate) {
      name = plan.defaults.name;
      startDate = plan.defaults.startDate;
      endDate = plan.defaults.endDate;
    }
  });

  async function create(e: SubmitEvent) {
    e.preventDefault();
    creating = true;
    const ok = await app.sprints.create({ name: name.trim() || undefined, goal: goal.trim() || undefined, startDate, endDate, ...(plan?.suggestion?.capacity ? { capacity: plan.suggestion.capacity } : {}) });
    creating = false;
    if (ok) {
      goal = '';
      startDate = '';
    }
  }

  function newSprint() {
    void app.sprints.create({});
  }

  let capacityTimer: ReturnType<typeof setTimeout> | null = null;
  function setCapacity(value: string, now = true) {
    if (!s) return;
    if (capacityTimer) clearTimeout(capacityTimer);
    capacityTimer = null;
    const n = value.trim() === '' ? null : Number(value.replace(',', '.'));
    if (n !== null && (!Number.isFinite(n) || n < 0)) return;
    if (n === capacity) return;
    const id = s.id;
    // Wait briefly while typing; on Enter or blur save right away.
    if (now) app.sprints.update(id, { capacity: n });
    else capacityTimer = setTimeout(() => app.sprints.update(id, { capacity: n }), 500);
  }
</script>

<header class="location-bar" data-testid="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    <a class="crumb sprints-crumb" href="/sprints" onclick={(e) => { e.preventDefault(); app.nav.go({ name: 'sprints' }); }}><span class="icon">{@html ICON.sprint}</span><span class="crumb-title">{t('Sprints')}</span></a>
    <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
    <span class="crumb"><span class="crumb-title" data-testid="view-title">{s ? t('Plan {name}', { name: s.name }) : t('Plan sprint')}</span></span>
  </div>
  <span class="bar-spacer"></span>
  {#if plan && plan.others.length > 1}
    <span class="seg desktop-only" data-testid="plan-switch">
      {#each plan.others as o (o.number)}
        <button class={[s?.number === o.number && 'on']} onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: String(o.number) })}>{o.name}</button>
      {/each}
    </span>
  {/if}
  {#if s}<button class="btn ghost small" aria-label={t('Another sprint')} data-testid="plan-new" onclick={newSprint}><span class="icon">{@html ICON.plus}</span><span class="btn-label">{t('Another sprint')}</span></button>{/if}
</header>

{#if plan && !s}
  <div class="page" data-testid="plan-create">
    <div class="page-content narrow">
      <h1 class="page-title">{t('Create sprint')}</h1>
      <p class="page-lead">{t('A sprint applies to all teams. It only runs once you deliberately start it after planning.')}</p>
      <form class="card-list form" onsubmit={create}>
        <label class="card-row"><span class="t">{t('Name')}</span><input class="input" data-testid="plan-name" bind:value={name} /></label>
        <label class="card-row"><span class="t">{t('Start')}</span><input class="input" type="date" data-testid="plan-start" bind:value={startDate} /></label>
        <label class="card-row"><span class="t">{t('End')}</span><input class="input" type="date" data-testid="plan-end" bind:value={endDate} /></label>
        <label class="card-row col"><span class="t">{t('Goal')} <span class="sub">{t('1–3 sentences, optional')}</span></span><textarea class="input" rows="2" data-testid="plan-goal" bind:value={goal} placeholder={t('What should be achieved by the end?')}></textarea></label>
        <div class="card-row">
          <span class="t sub">{plan.suggestion?.capacity ? t('Capacity: suggested {points} points (average of recent sprints)', { points: points(plan.suggestion.capacity) }) : plan.defaults.after ? t('Default: two weeks from the day after {name} ends', { name: plan.defaults.after }) : t('Default: two weeks from next Monday')}</span>
          <button class="btn primary" type="submit" data-testid="plan-create-submit" disabled={creating}>{t('Create sprint')}</button>
        </div>
      </form>
    </div>
  </div>
{:else if plan && s}
  <section class="plan-head" data-testid="plan-head" data-sprint={s.number}>
    <div class="plan-meta">
      <input class="plan-name" aria-label={t('Name')} value={s.name} onchange={(e) => app.sprints.update(s!.id, { name: e.currentTarget.value })} />
      <span class="plan-dates">
        <input class="input small" type="date" aria-label={t('Start')} value={s.startDate} onchange={(e) => app.sprints.update(s!.id, { startDate: e.currentTarget.value })} />
        <span>–</span>
        <input class="input small" type="date" aria-label={t('End')} value={s.endDate} onchange={(e) => app.sprints.update(s!.id, { endDate: e.currentTarget.value })} />
        <span class="stat-sub">{s.remaining}</span>
      </span>
      <span class="bar-spacer"></span>
      {#if plan.running}
        <span class="plan-hint" data-testid="plan-running" title={t('At most one sprint runs at a time. Close it first, then start.')}>{t('{name} is still running', { name: plan.running.name })}</span>
        <button class="btn small" onclick={() => app.nav.goView({ kind: 'close', team: null })}>{t('Close {name}', { name: plan.running.name })}</button>
      {/if}
      <button class="btn primary start" data-testid="plan-start-sprint" disabled={!!plan.running} title={plan.running ? t('{name} is still running', { name: plan.running.name }) : t('The sprint runs from now on; anything added afterwards counts as added late')} onclick={() => void app.sprints.start(s!.id)}>
        <span class="icon">{@html ICON.sprint}</span>{t('Start sprint')}
      </button>
    </div>
    <Goal sprintId={s.id} goal={s.goal} />
  </section>

  <div class="plan-cols">
    <div class={['plan-col', paneSlice.current === 'main' && 'active']} data-testid="plan-col-backlog">
      <div class="plan-col-head">
        <span class="icon">{@html ICON.backlog}</span>
        <span class="plan-col-title">{t('Backlog')}</span>
        <span class="bar-count"><span data-testid="plan-backlog-count">{mainHead.current.count}</span> {t('open, without sprint')}</span>
        <span class="bar-spacer"></span>
        <button class={['icon-btn', mainHead.current.filterCount > 0 && 'on']} title={tip(t('Filter'), 'filter.open')} aria-label={t('Filter')} data-testid="filter-button" onclick={() => { app.setPane('main'); app.palette.open('filter'); }}>
          <span class="icon">{@html ICON.filter}</span>
          {#if mainHead.current.filterCount > 0}<span class="badge-num">{mainHead.current.filterCount}</span>{/if}
        </button>
        <button class={['icon-btn', displayOpen.current && 'on']} title={tip(t('Display'), 'display.open')} aria-label={t('Display')} data-testid="display-button" onclick={() => { app.setPane('main'); app.toggleDisplay(); }}><span class="icon">{@html ICON.display}</span></button>
      </div>
      {#if mainHead.current.chips.length}
        <div class="chip-bar" data-testid="filter-bar">
          {#each mainHead.current.chips as chip (chip.field)}
            <span class="filter-chip" data-testid="filter-chip">{chip.label}<button aria-label={t('Remove filter')} onclick={() => app.main.removeFilter(chip.field)}><span class="icon">{@html ICON.close}</span></button></span>
          {/each}
          <button class="chip-link" onclick={() => app.main.clearFilters()}>{t('Reset filters')}</button>
        </div>
      {/if}
      <div class="budget-strip" data-testid="budget-strip" title={plan.limits.title}>
        {#each plan.teams as tm (tm.badge.id)}
          <span class={['budget-chip', tm.over && 'over']} data-testid="budget-chip" data-team={tm.badge.key} title="{tm.badge.name}: {tm.label}"
            ><TeamLogo team={tm.badge} size={14} /><span class="icon">{@html PRIORITY_ICON[1]}</span><span class={['n', tm.overUrgent && 'over']}>{tm.urgent}{plan.limits.urgent === null ? '' : `/${plan.limits.urgent}`}</span><span class="icon">{@html PRIORITY_ICON[2]}</span><span class={['n', tm.overHigh && 'over']}>{tm.high}{plan.limits.high === null ? '' : `/${plan.limits.high}`}</span></span
          >
        {/each}
      </div>
      <ListView list={app.main} testid="plan-backlog" drop={(ids, index) => app.sprints.drop(ids, app.main, index)} />
    </div>

    <div class={['plan-col', paneSlice.current === 'side' && 'active']} data-testid="plan-col-sprint">
      <div class="plan-col-head">
        <span class="icon">{@html ICON.sprint}</span>
        <span class="plan-col-title">{s.name}</span>
        <span class="bar-count"><span data-testid="plan-sprint-count">{sideHead.current.count}</span> {t('issues')}</span>
        <span class="bar-spacer"></span>
        <span class={['plan-points', over && 'over', capacity === null && suggested !== null && 'suggested']} data-testid="plan-points" title={over ? t('More points planned than capacity') : capacity === null && suggested !== null ? t('Capacity not set: suggestion from recent sprints') : ''}><b>{points(s.totals.points)}</b> / {effective !== null ? points(effective) : '–'} {t('points')}</span>
        <span class={['progress', over && 'over']}><div style:width="{load}%"></div></span>
      </div>
      <div class="capacity-row">
        <label>{t('Capacity')} <input class="input small num" data-testid="plan-capacity" inputmode="decimal" placeholder={plan.suggestion?.capacity != null ? points(plan.suggestion.capacity) : '–'} value={capacity !== null ? points(capacity) : ''} oninput={(e) => setCapacity(e.currentTarget.value, false)} onchange={(e) => setCapacity(e.currentTarget.value)} /> {t('points')}</label>
        {#if plan.suggestion}
          <span class="stat-sub" title={t('Average of completed points: {basis}', { basis: plan.suggestion.basis })}>{t('Suggested {points}', { points: plan.suggestion.capacity != null ? points(plan.suggestion.capacity) : '–' })}</span>
          {#if plan.suggestion.capacity != null && plan.suggestion.capacity !== capacity}
            <button class="chip-link" data-testid="plan-capacity-take" onclick={() => app.sprints.update(s!.id, { capacity: plan!.suggestion!.capacity })}>{t('Apply')}</button>
          {/if}
        {/if}
        {#if s.totals.unestimated}<span class="stat-sub">· {t('{count} without estimate', { count: s.totals.unestimated })}</span>{/if}
      </div>
      <ListView list={app.side} testid="plan-sprint" drop={(ids, index) => app.sprints.drop(ids, app.side, index)} />
    </div>
  </div>
  <div class="plan-keys desktop-only">
    <span><span class="kbd">→</span> {t('plan in')}</span><span><span class="kbd">←</span> {t('send back')}</span><span><span class="kbd">Tab</span> {t('column')}</span><span><span class="kbd">X</span> {t('select')}</span><span><span class="kbd">Alt ↑↓</span> {t('order')}</span><span>{t('or drag')}</span>
  </div>
{/if}

{#if shellSlice.current.peek}
  <Lazy load={pages.overlays} quiet>{#snippet children(o)}<o.Peek />{/snippet}</Lazy>
{/if}
{#if displayOpen.current}
  <Lazy load={pages.overlays} quiet>{#snippet children(o)}<o.DisplayPopover />{/snippet}</Lazy>
{/if}
