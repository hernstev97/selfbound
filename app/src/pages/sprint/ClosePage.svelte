<script lang="ts">
  import '../../styles/sprint.css';
  // Close a sprint: every open issue gets a decision. 1 = next sprint, 2 = backlog, 3 = cancel,
  // 0 = clear the decision; with a selection (X, Shift J/K, Ctrl A) for all at once. Done issues
  // count automatically. "Close" only once nothing is missing (the server checks again).
  import { ICON } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { points } from '@selfbound/core/sprintlogic';
  import { pages } from '../../lib/pages.ts';
  import Lazy from '../../components/Lazy.svelte';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import ListView from '../../components/ListView.svelte';

  const closingSlice = fromSlice(app.sprints.closing);
  const shellSlice = fromSlice(app.shell);
  const selection = fromSlice(app.main.selectionCount);
  const c = $derived(closingSlice.current);
  const s = $derived(c?.sprint ?? null);
  let retro = $state(app.sprints.retroDraft);
  let busy = $state(false);

  async function submit() {
    busy = true;
    await app.sprints.close(retro);
    busy = false;
  }

  // Ctrl Enter in the retrospective closes the sprint (like sending a comment) once nothing is missing.
  function retroKey(e: KeyboardEvent) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (c && c.summary.missing === 0 && !busy) void submit();
  }

  function decide(outcome: 'next' | 'backlog' | 'canceled') {
    app.sprints.decide(outcome);
  }
</script>

<header class="location-bar" data-testid="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    <a class="crumb" href="/sprint" onclick={(e) => { e.preventDefault(); app.nav.goView({ kind: 'sprint', team: null }); }}><span class="icon">{@html ICON.sprint}</span><span class="crumb-title">{s?.name ?? t('Sprint')}</span></a>
    <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
    <span class="crumb"><span class="crumb-title" data-testid="view-title">{tc('sprint', 'Close')}</span></span>
  </div>
</header>

{#if c && !s}
  <div class="empty" data-testid="empty-state">
    <div class="empty-icon"><span class="icon">{@html ICON.sprint}</span></div>
    <div class="empty-text">{t('No sprint is running, there is nothing to close.')}</div>
    <button class="btn" onclick={() => app.nav.goView({ kind: 'plan', team: null, sprint: null })}>{t('Plan sprint')}</button>
  </div>
{:else if c && s}
  {@const sum = c.summary}
  <section class="close-head" data-testid="close-head">
    <div class="close-counts">
      <div class="stat">
        <span class="stat-label">{t('Completed')}</span>
        <span class="stat-value" data-testid="close-done"><b>{sum.done}</b> {t('issues')} · {points(sum.donePoints)} {t('points')}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Open')}</span>
        <span class="stat-value"><b>{sum.decided}</b> / {sum.open} {t('decided')}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Next sprint')}</span>
        <span class="stat-value">{sum.counts.next}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Backlog')}</span>
        <span class="stat-value">{sum.counts.backlog}</span>
      </div>
      <div class="stat">
        <span class="stat-label">{t('Cancel')}</span>
        <span class="stat-value">{sum.counts.canceled}</span>
      </div>
    </div>
    <div class="close-row">
      <label class="close-target">{t('Carry over to')}
        <span class="dp-select">
          <select data-testid="close-target" value={c.target} onchange={(e) => app.sprints.setTarget(e.currentTarget.value)}>
            {#each c.targets as target (target.id)}<option value={target.id}>{target.label}</option>{/each}
          </select>
          <span class="icon">{@html ICON.chevronDown}</span>
        </span>
      </label>
      <span class="bar-spacer"></span>
      <span class="decide-buttons">
        <button class="btn small" onclick={() => decide('next')} title={t('Key {key}', { key: 1 })}>{t('Next sprint')} <span class="kbd inline">1</span></button>
        <button class="btn small" onclick={() => decide('backlog')} title={t('Key {key}', { key: 2 })}>{t('Backlog')} <span class="kbd inline">2</span></button>
        <button class="btn small" onclick={() => decide('canceled')} title={t('Key {key}', { key: 3 })}>{t('Cancel')} <span class="kbd inline">3</span></button>
      </span>
      {#if selection.current > 0}<span class="stat-sub">{tc('sprint', '{count} selected', { count: selection.current })}</span>{/if}
    </div>
  </section>

  <ListView list={app.main} />

  <footer class="close-foot">
    <textarea class="input retro" data-testid="close-retro" rows="2" placeholder={t('Short retrospective (optional): what went well, what did not?')} bind:value={retro} oninput={() => (app.sprints.retroDraft = retro)} onkeydown={retroKey}></textarea>
    <div class="close-submit">
      {#if sum.missing > 0}<span class="plan-hint" data-testid="close-missing">{t('{count} still without a decision', { count: sum.missing })}</span>{/if}
      <button class="btn primary start" data-testid="close-submit" disabled={sum.missing > 0 || busy} onclick={() => void submit()}>
        <span class="icon">{@html ICON.check}</span>{t('Close {name}', { name: s.name })}
      </button>
    </div>
  </footer>
{/if}

{#if shellSlice.current.peek}
  <Lazy load={pages.overlays} quiet>{#snippet children(o)}<o.Peek />{/snippet}</Lazy>
{/if}
