<script lang="ts">
  import { ICON, VIEWS, actionById, viewPath } from '@selfbound/core';
  import { t, tc } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { autofocus, tip } from '../lib/ui.ts';
  import TeamLogo from '../components/TeamLogo.svelte';
  import ListView from '../components/ListView.svelte';
  import { pages } from '../lib/pages.ts';
  import SplitView from '../components/SplitView.svelte';
  import Lazy from '../components/Lazy.svelte';

  const headerSlice = fromSlice(app.main.header);
  const boardSlice = fromSlice(app.main.board);
  const shellSlice = fromSlice(app.shell);
  const displayOpen = fromSlice(app.displayOpen);
  const sidebarSlice = fromSlice(app.sidebar);
  const h = $derived(headerSlice.current);
  const viewIconName = $derived(VIEWS[h.kind].icon);
  let scrolled = $state(false);
  // Split view: opening an issue as a page (Enter) keeps the list as it was (mounted, only hidden).
  // Otherwise the switch would tear the list down and rebuild it on the way back.
  let viewSplit = $state(false);
  $effect.pre(() => {
    if (shellSlice.current.page === 'view') viewSplit = shellSlice.current.split;
  });
  const split = $derived(shellSlice.current.page === 'view' ? shellSlice.current.split : viewSplit);

  function copyViewLink() {
    void app.edit.copy(location.href, t('Link to the view'));
  }
</script>

{#if h.kind === 'plan'}
  <Lazy load={pages.plan} />
{:else if h.kind === 'close'}
  <Lazy load={pages.close} />
{:else}
  <!-- Split view (wide inbox, or opened with ⇧ space): list on the left, issue on the right. The
       wrapper is always there, so opening and closing it does not rebuild the list. -->
  <SplitView active={split} inbox={h.kind === 'inbox'}>{@render listContent()}</SplitView>
{/if}

{#snippet listContent()}
<header class="location-bar" data-testid="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon mi ui-menu"></span></button>
  <div class="crumbs">
    {#if h.team}
      <a class="crumb" href={viewPath({ kind: 'active', team: h.team.key })} onclick={(e) => { e.preventDefault(); app.nav.goView({ kind: 'active', team: h.team!.key }); }}>
        <TeamLogo team={h.team} size={14} /><span class="crumb-title">{h.team.name}</span>
      </a>
      <span class="icon crumb-sep mi ui-chevronRight"></span>
    {/if}
    <span class="crumb"><span class="icon mi ui-{viewIconName}"></span><span class="crumb-title" data-testid="view-title">{h.title}</span></span>
  </div>
  <span class="bar-spacer"></span>
  {#if h.kind === 'sprint' && !h.team}
    <Lazy load={pages.sprintHeader} quiet>{#snippet children(m)}<m.SprintActions />{/snippet}</Lazy>
  {/if}
  {#if h.kind === 'inbox' && h.count > 0}
    <!-- Inbox: mark all read, or done for today (only the entries go; the issues stay). -->
    <button class="btn ghost small" disabled={sidebarSlice.current.inbox === 0} title={tip(t('Mark all as read'), 'inbox.readAll')} aria-label={t('All read')} data-testid="inbox-read-all" onclick={() => actionById('inbox.readAll')?.run(app)}><span class="icon mobile-only">{@html ICON.eye}</span><span class="btn-label">{t('All read')}</span></button>
    <button class="btn ghost small" title={t('Remove all entries from the inbox; the issues stay as they are')} aria-label={t('Done for today')} data-testid="inbox-clear" onclick={() => actionById('inbox.clearAll')?.run(app)}><span class="icon mi ui-check"></span><span class="btn-label">{t('Done for today')}</span></button>
  {/if}
  <button class="icon-btn plain mobile-only" aria-label={tc('verb', 'Search')} onclick={() => app.palette.open('search')}><span class="icon mi ui-search"></span></button>
  <button class="icon-btn plain desktop-only" title={t('Copy link to the view')} aria-label={t('Copy link')} onclick={copyViewLink}><span class="icon mi ui-link"></span></button>
</header>

{#if h.kind === 'sprint' && !h.team}
  <Lazy load={pages.sprintHeader} quiet />
{/if}

<div class={['view-bar', scrolled && 'scrolled']} data-testid="view-bar">
  {#if h.tabs.length}
    <div class="tabs">
      {#each h.tabs as tab (tab.route.kind)}
        <a class={['tab', tab.active && 'active']} href={viewPath(tab.route)} onclick={(e) => { e.preventDefault(); app.nav.goView(tab.route); }} data-testid="tab-{tab.route.kind}">{tab.label}</a>
      {/each}
    </div>
  {/if}
  <span class="bar-count" data-testid="view-count-text"><span data-testid="view-count">{h.count}</span> {h.count === 1 ? t('issue') : t('issues')}</span>
  <span class="bar-spacer"></span>
  {#if shellSlice.current.canSplit && h.kind !== 'inbox'}
    <button class={['icon-btn', split && 'on']} title={tip(split ? t('Close split view') : t('Open in split view'), 'view.split')} aria-label={t('Split view')} aria-pressed={split} data-testid="split-toggle" onclick={() => app.detail.toggleSplit()}>
      <span class="icon">{@html ICON.split}</span>
    </button>
  {/if}
  {#if VIEWS[h.kind].boardTypes}
    <button class="icon-btn" title={tip(boardSlice.current ? t('Show as list') : t('Show as board'), 'layout.toggle')} aria-label={boardSlice.current ? t('List') : t('Board')} data-testid="layout-toggle" onclick={() => app.main.toggleLayout()}>
      <span class="icon mi ui-{boardSlice.current ? 'list' : 'board'}"></span>
    </button>
  {/if}
  <button class={['icon-btn', h.filterCount > 0 && 'on']} title={tip(t('Filter'), 'filter.open')} aria-label={t('Filter')} onclick={() => app.palette.open('filter')} data-testid="filter-button">
    <span class="icon mi ui-filter"></span>
    {#if h.filterCount > 0}<span class="badge-num">{h.filterCount}</span>{/if}
  </button>
  <button class={['icon-btn', displayOpen.current && 'on']} title={tip(t('Display'), 'display.open')} aria-label={t('Display')} onclick={() => app.toggleDisplay()} data-testid="display-button">
    <span class="icon mi ui-display"></span>
    {#if h.displayChanged}<span class="badge-dot"></span>{/if}
  </button>
</div>

{#if h.chips.length || h.quickOpen}
  <div class="chip-bar" data-testid="filter-bar">
    {#if h.quickOpen}
      <span class="quick-wrap">
        <span class="icon mi ui-search"></span>
        <input class="quick-search" data-role="quick" data-testid="quick-search" placeholder={t('Filter by title or identifier …')} value={h.quick} oninput={(e) => app.main.setQuick(e.currentTarget.value)} {@attach autofocus} />
      </span>
    {/if}
    {#each h.chips as chip (chip.field)}
      <span class="filter-chip" data-testid="filter-chip">
        {chip.label}<button aria-label={t('Remove filter')} data-testid="filter-chip-remove" onclick={() => app.main.removeFilter(chip.field)}><span class="icon mi ui-close"></span></button>
      </span>
    {/each}
    {#if h.chips.length}
      <button class="chip-link" onclick={() => app.main.clearFilters()}>{t('Reset filters')}</button>
    {/if}
  </div>
{/if}

{#if boardSlice.current}
  <Lazy load={pages.board} />
{:else}
  <ListView scrollChange={(v) => (scrolled = v)} />
{/if}
{/snippet}

{#if h.kind !== 'plan' && h.kind !== 'close'}

{#if shellSlice.current.peek}
  <Lazy load={pages.overlays} quiet>{#snippet children(o)}<o.Peek />{/snippet}</Lazy>
{/if}
{#if displayOpen.current}
  <Lazy load={pages.overlays} quiet>{#snippet children(o)}<o.DisplayPopover />{/snippet}</Lazy>
{/if}
{/if}
