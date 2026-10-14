<script lang="ts">
  import { pagePath, type Page, type SidebarTeam } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { untrack } from 'svelte';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { tip } from '../lib/ui.ts';
  import { SidebarMotion, deferredSidebar } from '../lib/sidebarMotion.ts';
  import Logo from './Logo.svelte';
  import TeamLogo from './TeamLogo.svelte';
  import { pages } from '../lib/pages.ts';
  import Lazy from './Lazy.svelte';

  const shellSlice = fromSlice(app.shell);

  // On a team switch, one frame after the content on the right (lib/sidebarMotion.ts).
  const deferred = deferredSidebar(app.sidebar);
  $effect(() => deferred.stop);
  const sidebarSlice = fromSlice(deferred.shown);
  const syncSlice = fromSlice(app.store.sync);
  const statsSlice = fromSlice(app.teamStats);
  const sb = $derived(sidebarSlice.current);
  const sync = $derived(syncSlice.current);

  function go(e: MouseEvent, page: Page) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    app.nav.go(page);
  }
  const view = (kind: 'inbox' | 'snoozed' | 'triage' | 'all' | 'sprint' | 'trash' | 'active' | 'backlog', team: string | null = null): Page => ({ name: 'view', view: { kind, team } });
  const P = {
    inbox: view('inbox'),
    snoozed: view('snoozed'),
    triage: view('triage'),
    all: view('all'),
    sprint: view('sprint'),
    plan: { name: 'view', view: { kind: 'plan', team: null, sprint: null } } as Page,
    trash: view('trash'),
    drafts: { name: 'drafts' } as Page,
    settings: { name: 'settings', section: 'general' } as Page,
  };
  const sprintPage = $derived(sb.sprint || !sb.planning ? P.sprint : P.plan);
  const teamPages = (key: string) => ({ triage: view('triage', key), issues: view('active', key), backlog: view('backlog', key), projects: { name: 'projects', team: key } as Page, wiki: { name: 'wiki', team: key } as Page, settings: { name: 'settings', section: 'teams', sub: key } as Page });

  // The list comes first on startup: the cards of the other teams follow one frame after the first
  // issues (after syncing when the store is empty). Otherwise startup would paint them in the same frame.
  let cardsReady = $state(false);
  $effect(() => {
    if (cardsReady) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (frame || (app.store.version.get() === 0 && app.store.sync.get().phase !== 'live')) return;
      frame = requestAnimationFrame(() => (timer = setTimeout(() => (cardsReady = true), 0)));
    };
    const stops = [app.store.version.subscribe(check), app.store.sync.subscribe(check)];
    check();
    return () => {
      for (const stop of stops) stop();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  });

  // Team switch and sections open/closed (lib/sidebarMotion.ts): measure only when the layout changes.
  const motion = new SidebarMotion();
  let scroller = $state<HTMLElement>();
  let currentCard = $state<HTMLElement>();
  /** Switch by keyboard (Enter on a card): afterwards focus is on the card at the top. */
  let focusCurrent = false;
  // Only what the user triggers animates: team switch, section open/closed. When data changes
  // (triage entry, new team), the sidebar jumps like everywhere else in the app.
  const layout = $derived([sb.current?.key, sb.teamsCollapsed, sb.dormantCollapsed, sb.teamSize].join('|'));
  $effect.pre(() => {
    void layout;
    // Nothing moves while loading (teams and triage counts arrive bit by bit): the frames belong to the list.
    untrack(() => motion.before(cardsReady && app.store.sync.get().phase === 'live' ? scroller : null, sb.current?.key ?? null));
  });
  $effect(() => {
    void layout;
    untrack(() => {
      // Phone: the drawer closes on a switch anyway, so only sections open/closed animate there.
      const closed = app.mobile.get() && !app.mobileDrawer.get();
      motion.after(scroller, sb.current?.key ?? null, { animate: !closed });
      if (focusCurrent) currentCard?.focus({ preventScroll: true });
      focusCurrent = false;
    });
  });

  function pick(e: MouseEvent, team: SidebarTeam) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    // Clicks triggered by Enter have detail 0.
    focusCurrent = e.detail === 0;
    app.switchTeam(team.key);
  }

  /** Numbers on the card: sprint progress if the team has issues in the running sprint, otherwise open issues by status type. */
  function stats(team: SidebarTeam) {
    // Knowledge-only team: no numbers, nothing to count.
    if (team.wiki === 'only') return { text: t('Knowledge'), pct: null, title: t('Knowledge only') };
    const c = statsSlice.current[team.key];
    if (!c) return { text: '', pct: null, title: '' };
    if (sb.sprint && c.sprintIssues > 0) {
      const pct = Math.round((c.sprintDone / c.sprintIssues) * 100);
      return { text: t('Sprint {pct}% done', { pct }), pct, title: t('{done} of {total} issues in {sprint} done', { done: c.sprintDone, total: c.sprintIssues, sprint: sb.sprint }) };
    }
    return { text: t('{todo} to do · {started} in progress', { todo: c.todo, started: c.started }), pct: null, title: t('{todo} not started, {started} started', { todo: c.todo, started: c.started }) };
  }
</script>

{#snippet card(team: SidebarTeam, current: boolean)}
  {@const st = stats(team)}
  {@const big = current || sb.teamSize === 'large'}
  <!-- The team switch moves parts with data-part one by one: the row grows into the card (lib/sidebarMotion.ts). -->
  <span class="tc-bg" data-part="bg"></span>
  <span class="tc-logo" data-part="logo"><TeamLogo team={team.badge} size={big ? 40 : 24} /></span>
  <span class="tc-text">
    <span class="tc-name" data-part="name">{team.badge.name}</span>
    {#if big}
      <span class="tc-stats" data-part="stats" data-testid="team-stats">
        {#if st.pct !== null}<span class="tc-bar" style:--pct="{st.pct}%"></span>{/if}{st.text}
      </span>
    {/if}
  </span>
  {#if current}
    <span class="sr-only">{t('(current team)')}</span>
    <!-- Inward-curved corners at top and bottom where the card meets the content panel -->
    <span class="tc-dock" data-part="dock" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet teamCard(team: SidebarTeam)}
  {@const tp = teamPages(team.key)}
  <a class={['team-card', sb.teamSize === 'small' && 'small']} href={pagePath(team.wiki === 'only' ? tp.wiki : tp.issues)} onclick={(e) => pick(e, team)} data-flip="team:{team.key}" data-testid="nav-team-{team.key}" title={[team.badge.name, stats(team).title].filter(Boolean).join(': ')}>
    {@render card(team, false)}
  </a>
{/snippet}

{#snippet addTeam()}
  <button class="add-team" title={tip(t('Add team'), 'team.new')} aria-label={t('Add team')} onclick={() => app.openNewTeam()} data-testid="nav-team-add">
    <span class="icon mi ui-plus"></span>
  </button>
{/snippet}

<aside class="sidebar" data-testid="sidebar">
  {#if shellSlice.current.page === 'settings'}
    <Lazy load={pages.settingsNav} quiet />
  {:else}
  <div class="ws-head">
    <button class="ws-name" onclick={() => app.palette.open('command')} title="Selfbound">
      <Logo kind="lockup" height={15} />
      <span class="icon mi ui-chevronDown" style="color: var(--text-muted); width: 12px"></span>
    </button>
    <span class="spacer"></span>
    <button class="ws-search" title={tip(t('Search'), 'search.open')} aria-label={t('Search')} onclick={() => app.palette.open('search')} data-testid="nav-search">
      <span class="icon mi ui-search"></span>
    </button>
    <button class="ws-compose" title={tip(t('New issue'), 'issue.create')} aria-label={t('New issue')} onclick={() => app.create.open()} data-testid="nav-create">
      <span class="icon mi ui-compose"></span>
      {#if sb.drafts > 0}<span class="dot"></span>{/if}
    </button>
  </div>

  <nav class="nav-scroll" bind:this={scroller}>
    <a class={['nav-item', sb.active === 'inbox' && 'active']} href={pagePath(P.inbox)} onclick={(e) => go(e, P.inbox)} data-testid="nav-inbox" title={tip(t('Inbox'), 'go.inbox')}>
      <span class="icon mi ui-inbox"></span><span class="label">{t('Inbox')}</span>
      {#if sb.inbox > 0}<span class="count" data-testid="inbox-count">{sb.inbox}</span>{/if}
    </a>
    <a class={['nav-item', sb.active === 'triage' && 'active']} href={pagePath(P.triage)} onclick={(e) => go(e, P.triage)} data-testid="nav-triage" title={tip(t('Triage'), 'go.triage')}>
      <span class="icon mi ui-triage"></span><span class="label">{t('Triage')}</span>
      {#if sb.triage > 0}<span class="count" data-testid="triage-count">{sb.triage}</span>{/if}
    </a>
    <a class={['nav-item', (sb.active === 'all' || sb.active === 'active' || sb.active === 'backlog') && 'active']} href={pagePath(P.all)} onclick={(e) => go(e, P.all)} data-testid="nav-all" title={tip(t('All issues'), 'go.all')}>
      <span class="icon mi ui-issues"></span><span class="label">{t('All issues')}</span>
    </a>
    <a class={['nav-item', sb.active === 'sprint' && 'active']} href={pagePath(sprintPage)} onclick={(e) => go(e, sprintPage)} data-testid="nav-sprint" title={tip(sb.sprint ? t('Current sprint') : t('Sprint planning'), 'go.sprint')}>
      <span class="icon mi ui-sprint"></span><span class="label">{sb.sprint ?? (sb.planning ? t('Planning') : t('Sprint'))}</span>
    </a>
    {#if sb.snoozed > 0}
      <a class={['nav-item', sb.active === 'snoozed' && 'active']} href={pagePath(P.snoozed)} onclick={(e) => go(e, P.snoozed)} data-testid="nav-snoozed" title={tip(t('Snoozed'), 'go.snoozed')}>
        <span class="icon mi ui-snooze"></span><span class="label">{t('Snoozed')}</span><span class="count" data-testid="snoozed-count">{sb.snoozed}</span>
      </a>
    {/if}
    {#if sb.drafts > 0}
      <a class={['nav-item', sb.active === 'drafts' && 'active']} href={pagePath(P.drafts)} onclick={(e) => go(e, P.drafts)} data-testid="nav-drafts">
        <span class="icon mi ui-compose"></span><span class="label">{t('Drafts')}</span><span class="count">{sb.drafts}</span>
      </a>
    {/if}

    {#if sb.current}
      <div class="nav-section static" data-flip="head:current">{t('Current team')}</div>
      <!-- Rebuilt per team: the old entries stay unchanged for their fading snapshot. -->
      {#key sb.current.key}
      {@const team = sb.current}
      {@const tp = teamPages(team.key)}
      <div class="team-card current" tabindex="-1" role="group" aria-label={t('Current team: {name}', { name: team.badge.name })} bind:this={currentCard} data-flip="team:{team.key}" data-testid="nav-team-{team.key}" data-current="" title={[team.badge.name, stats(team).title].filter(Boolean).join(': ')}>
        {@render card(team, true)}
      </div>
      <div class="team-nav" data-testid="current-team-nav">
        {#if team.wiki !== 'only'}
        {#if team.triage > 0}
          <a class={['nav-item', sb.active === `team:${team.key}:triage` && 'active']} href={pagePath(tp.triage)} onclick={(e) => go(e, tp.triage)} data-flip="nav:{team.key}:triage">
            <span class="icon mi ui-triage"></span><span class="label">{t('Triage')}</span><span class="count">{team.triage}</span>
          </a>
        {/if}
        <a class={['nav-item', sb.active === `team:${team.key}:active` && 'active']} href={pagePath(tp.issues)} onclick={(e) => go(e, tp.issues)} data-flip="nav:{team.key}:issues" data-testid="nav-team-{team.key}-issues">
          <span class="icon mi ui-issues"></span><span class="label">{t('Issues')}</span>
        </a>
        <a class={['nav-item', sb.active === `team:${team.key}:backlog` && 'active']} href={pagePath(tp.backlog)} onclick={(e) => go(e, tp.backlog)} data-flip="nav:{team.key}:backlog" data-testid="nav-team-{team.key}-backlog">
          <span class="icon mi ui-backlog"></span><span class="label">{t('Backlog')}</span>
        </a>
        <a class={['nav-item', sb.active === `team:${team.key}:projects` && 'active']} href={pagePath(tp.projects)} onclick={(e) => go(e, tp.projects)} data-flip="nav:{team.key}:projects" data-testid="nav-team-{team.key}-projects">
          <span class="icon mi ui-projects"></span><span class="label">{t('Projects')}</span>
        </a>
        {/if}
        {#if team.wiki}
          <a class={['nav-item', sb.active === `team:${team.key}:wiki` && 'active']} href={pagePath(tp.wiki)} onclick={(e) => go(e, tp.wiki)} data-flip="nav:{team.key}:wiki" data-testid="nav-team-{team.key}-wiki" title={tip(t('Knowledge'), 'go.wiki')}>
            <span class="icon mi ui-wiki"></span><span class="label">{t('Knowledge')}</span>
          </a>
        {/if}
        <a class="nav-item" href={pagePath(tp.settings)} onclick={(e) => go(e, tp.settings)} data-flip="nav:{team.key}:settings" data-testid="nav-team-{team.key}-settings" title={tip(t('Team settings'), 'team.settings')}>
          <span class="icon mi ui-settings"></span><span class="label">{t('Settings')}</span>
        </a>
      </div>
      {/key}
    {/if}

    <!-- Header even without other teams: the plus belongs to it. -->
    {#if cardsReady}
      <div class="nav-section-row" data-flip="head:teams">
        <button class="nav-section" onclick={() => app.prefs.set({ teamsCollapsed: !sb.teamsCollapsed })} aria-expanded={!sb.teamsCollapsed} data-testid="nav-teams">
          {t('Teams')} <span class={['icon caret mi ui-caretDown', sb.teamsCollapsed && 'closed']}></span>
        </button>
        {@render addTeam()}
      </div>
      {#if !sb.teamsCollapsed}
        {#each sb.teams as team (team.id)}
          {@render teamCard(team)}
        {/each}
      {/if}
    {/if}

    {#if cardsReady && sb.dormant.length > 0}
      <button class="nav-section" onclick={() => app.prefs.set({ dormantCollapsed: !sb.dormantCollapsed })} aria-expanded={!sb.dormantCollapsed} data-flip="head:dormant" data-testid="nav-dormant">
        {t('Inactive')} <span class={['icon caret mi ui-caretDown', sb.dormantCollapsed && 'closed']}></span>
      </button>
      {#if !sb.dormantCollapsed}
        {#each sb.dormant as team (team.id)}
          {@render teamCard(team)}
        {/each}
      {/if}
    {/if}
  </nav>

  <div class="sidebar-foot">
    {#if sync.visible}
      <div class="sync-state" data-testid="sync-state"><span class="pulse"></span>{sync.text}</div>
    {/if}
    <a class={['nav-item', sb.active === 'trash' && 'active']} href={pagePath(P.trash)} onclick={(e) => go(e, P.trash)} data-testid="nav-trash">
      <span class="icon mi ui-trash"></span><span class="label">{t('Trash')}</span>
    </a>
    <a class={['nav-item', sb.active === 'settings' && 'active']} href={pagePath(P.settings)} onclick={(e) => go(e, P.settings)} data-testid="nav-settings">
      <span class="icon mi ui-settings"></span><span class="label">{t('Settings')}</span>
    </a>
    <button class="help-btn" title={tip(t('Keyboard shortcuts'), 'help.open')} aria-label={t('Keyboard shortcuts')} onclick={() => app.palette.open('help')}>?</button>
  </div>
  {/if}
</aside>
