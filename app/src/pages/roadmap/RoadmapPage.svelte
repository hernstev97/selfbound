<script lang="ts">
  // Roadmap page of a team (/team/KEY/roadmap, SELF-113): the release view (projects as columns,
  // categories with cards) and the progress tracker (time axis), as two tabs. Data, filters, folding
  // and keyboard focus live in core/src/app/roadmap.ts. A click opens the issue beside the page in a
  // wide window (the regular issue detail, fully editable), otherwise as its own page.
  import '../../styles/pages.css';
  import '../../styles/roadmap.css';
  import { api } from '@selfbound/backend/api';
  import { STAGES } from '@selfbound/backend/shared/roadmap';
  import { ICON, type TeamId } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { pages } from '../../lib/pages.ts';
  import { tip } from '../../lib/ui.ts';
  import Lazy from '../../components/Lazy.svelte';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import ReleaseView from './ReleaseView.svelte';
  import ProgressView from './ProgressView.svelte';
  import { STAGE_TEXT } from './labels.ts';

  const uiSlice = fromSlice(app.roadmap.ui);
  const releaseSlice = fromSlice(app.roadmap.release);
  const metaSlice = fromSlice(app.store.meta);
  const besideSlice = fromSlice(app.detail.beside);
  const shellSlice = fromSlice(app.shell);
  const wideSlice = fromSlice(app.wide);
  const exportSlice = fromSlice(app.roadmap.exportOpen);
  const ui = $derived(uiSlice.current);
  const team = $derived(metaSlice.current?.teams.find((x) => x.key === ui.team) ?? null);
  const projects = $derived(metaSlice.current?.projects.filter((p) => p.teamId === team?._id && p.state !== 'canceled') ?? []);
  const release = $derived(releaseSlice.current);
  const beside = $derived(besideSlice.current !== null && wideSlice.current && !shellSlice.current.mobile);
  const filterCount = $derived(ui.filters.categories.length + ui.filters.stages.length);

  // A window that got narrow closes the issue beside it (it would have no room).
  $effect(() => {
    if (besideSlice.current !== null && (!wideSlice.current || shellSlice.current.mobile)) app.detail.showBeside(null);
  });

  async function turnOn() {
    if (!team) return;
    await app.store.call(api.roadmap.updateSettings, { teamId: team._id as TeamId, on: true }).catch((e: unknown) => app.toasts.error(t('Roadmap not turned on'), e));
  }
</script>

<header class="location-bar rm-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    {#if team}<span class="crumb"><TeamLogo team={app.main.teamBadge(team._id)} size={14} /><span class="crumb-title">{team.name}</span></span><span class="icon crumb-sep">{@html ICON.chevronRight}</span>{/if}
    <span class="crumb"><span class="icon">{@html ICON.roadmap}</span><span class="crumb-title">{t('Roadmap')}</span></span>
  </div>
  <div class="seg rm-tabs" role="tablist" aria-label={t('View')}>
    <button role="tab" aria-selected={ui.tab === 'release'} class={[ui.tab === 'release' && 'on']} title={tip(t('Roadmap: stages as columns'), 'roadmap.release')} data-testid="roadmap-tab-release" onclick={() => app.roadmap.setTab('release')}>{t('Roadmap')}</button>
    <button role="tab" aria-selected={ui.tab === 'progress'} class={[ui.tab === 'progress' && 'on']} title={tip(t('Progress on a time axis'), 'roadmap.progress')} data-testid="roadmap-tab-progress" onclick={() => app.roadmap.setTab('progress')}>{t('Progress')}</button>
  </div>
  <span class="bar-spacer"></span>
  {#if team?.roadmap?.on && projects.length}
    <button class={['btn', 'ghost', 'small', ui.filters.publicOnly && 'on']} aria-pressed={ui.filters.publicOnly} title={tip(t('Show only public issues, as in the image export'), 'roadmap.public')} data-testid="roadmap-public-only" onclick={() => app.roadmap.togglePublicOnly()}>
      <span class="icon">{@html ICON.eye}</span><span class="btn-label">{t('Only public')}</span>
    </button>
    <button class="icon-btn plain" title={tip(ui.tab === 'release' ? t('Expand or collapse all categories') : t('Expand or collapse all rows'), 'roadmap.toggleAll')} aria-label={t('Expand or collapse all')} data-testid="roadmap-toggle-all" onclick={() => app.roadmap.toggleAll()}>
      <span class="icon">{@html ICON.expand}</span>
    </button>
    <button class="btn small" title={tip(t('Export as an image with public issues only'), 'roadmap.export')} data-testid="roadmap-export" onclick={() => app.roadmap.exportOpen.set(true)}>
      <span class="icon">{@html ICON.image}</span><span class="btn-label">{t('Export image')}</span>
    </button>
  {/if}
</header>

<div class={['rm-body', beside && 'beside']} data-testid="roadmap-page" data-tab={ui.tab}>
  <div class="rm-main">
    {#if !team}
      <div class="empty"><div class="empty-text">{t('Team {key} does not exist.', { key: ui.team ?? '' })}</div></div>
    {:else if !team.roadmap?.on}
      <div class="empty" data-testid="roadmap-off">
        <div class="empty-icon"><span class="icon">{@html ICON.roadmap}</span></div>
        <div class="empty-text">{t('The roadmap of {team} is off. It shows the projects as stages, with their issues by category, and exports an image with public issues only.', { team: team.name })}</div>
        <div class="rm-empty-actions">
          <button class="btn primary" data-testid="roadmap-turn-on" onclick={() => void turnOn()}>{t('Turn on roadmap')}</button>
          <button class="btn" onclick={() => app.openTeamSettings(team!.key)}>{t('Team settings')}</button>
        </div>
      </div>
    {:else if projects.length === 0}
      <div class="empty" data-testid="roadmap-no-projects">
        <div class="empty-icon"><span class="icon">{@html ICON.projects}</span></div>
        <div class="empty-text">{t('{team} has no projects yet. Every project is a stage of the roadmap; create them in the settings.', { team: team.name })}</div>
        <button class="btn" onclick={() => app.nav.go({ name: 'settings', section: 'projects' })}>{t('Create projects')}</button>
      </div>
    {:else}
      <div class="rm-filters" role="toolbar" aria-label={t('Filter')}>
        {#each release?.categories ?? [] as c (c.key)}
          <button class={['rm-chip', ui.filters.categories.includes(c.key) && 'on']} aria-pressed={ui.filters.categories.includes(c.key)} data-testid="roadmap-filter-category" onclick={() => app.roadmap.toggleCategoryFilter(c.key)}>
            {#if c.hue !== null}<span class="rm-dot" style:--hue={c.hue}></span>{/if}{c.name}
          </button>
        {/each}
        {#if release?.categories.length}<span class="rm-sep" aria-hidden="true"></span>{/if}
        {#each STAGES as stage (stage)}
          <button class={['rm-chip', ui.filters.stages.includes(stage) && 'on']} aria-pressed={ui.filters.stages.includes(stage)} data-testid="roadmap-filter-stage" data-stage={stage} onclick={() => app.roadmap.toggleStageFilter(stage)}>
            <span class="rm-stage-dot" data-stage={stage}></span>{STAGE_TEXT[stage]}
          </button>
        {/each}
        {#if filterCount > 0}
          <button class="rm-chip plain" data-testid="roadmap-filter-clear" onclick={() => app.roadmap.clearFilters()}><span class="icon">{@html ICON.close}</span>{t('Clear filters')}</button>
        {/if}
        {#if release && release.filtered > 0}<span class="rm-filter-note">{t('{count} hidden by filters', { count: release.filtered })}</span>{/if}
        {#if release && !release.grouped}
          <button class="rm-chip plain" title={t('Pick a label group as categories in the team settings')} onclick={() => app.openTeamSettings(team!.key)}><span class="icon">{@html ICON.label}</span>{t('Choose categories')}</button>
        {/if}
      </div>
      {#if ui.tab === 'release'}<ReleaseView />{:else}<ProgressView />{/if}
    {/if}
  </div>
  {#if beside}
    <aside class="rm-beside split-detail" aria-label={t('Issue')} data-testid="roadmap-beside">
      <Lazy load={pages.issue}>{#snippet children(m)}<m.default split />{/snippet}</Lazy>
    </aside>
  {/if}
</div>

{#if exportSlice.current && team}
  <Lazy load={() => import('./ExportDialog.svelte')} />
{/if}
