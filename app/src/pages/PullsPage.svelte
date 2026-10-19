<script lang="ts">
  // Pull requests page (/pulls, SELF-100): the PRs linked to an issue, grouped by what comes next.
  // Data, J/K and Enter live in core/src/app/pulls.ts (the server groups). A click opens the PR beside
  // the list (PrHost, wide windows) or as its own page; merging stays in the PR view.
  import '../styles/pr.css';
  import type { PrBlocker, PrGroup, PrListItem } from '@selfbound/backend/shared/pullRequests';
  import { ICON, fullDate, relativeTime, statusIcon, workflowsOf, type IssueId } from '@selfbound/core';
  import { t, tn, translated } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import PrHost from '../components/pr/PrHost.svelte';
  import { STATE_LABEL, checksText } from '../components/pr/prText.ts';
  import { mentionClass } from '../lib/mentions.ts';
  import { DOCS } from '../lib/docs.ts';
  import { tip } from '../lib/ui.ts';

  const stateSlice = fromSlice(app.pulls.state);
  const prSlice = fromSlice(app.prSplit);
  const metaSlice = fromSlice(app.store.meta);
  // Issue chips follow status and title changes of the linked issues (a handful of rows).
  const versionSlice = fromSlice(app.store.version);
  const s = $derived(stateSlice.current);
  const workflows = $derived(workflowsOf(metaSlice.current));

  const GROUP_LABEL: Record<PrGroup, string> = translated({
    ready: 'Ready to merge',
    failing: 'Checks failing',
    running: 'Checks running',
    blocked: 'Blocked',
    draft: 'Draft',
    done: 'Merged or closed',
  });
  const GROUP_TINT: Record<PrGroup, string> = {
    ready: 'var(--status-review)',
    failing: 'var(--danger)',
    running: 'var(--status-progress)',
    blocked: 'var(--triage-text)',
    draft: 'var(--text-muted)',
    done: 'var(--status-done)',
  };
  const BLOCKER_LABEL: Record<PrBlocker, string> = translated({
    conflicts: 'Conflicts',
    changes_requested: 'Changes requested',
    rules: 'Blocked by rules',
    unknown: 'Not loaded from GitHub yet',
  });
  const CHIPS_MAX = 3;

  const count = $derived(s.groups.reduce((n, g) => n + (g.group === 'done' ? 0 : g.items.length), 0));
  const example = $derived(`${app.currentTeam() ?? 'ACME'}-42`);

  function issues(pr: PrListItem) {
    void versionSlice.current;
    const out: { id: string; key: string; title: string; label: string; icon: string; cls: string }[] = [];
    for (const id of pr.issueIds) {
      const issue = app.store.get(id as IssueId);
      if (!issue || issue.deletedAt) continue;
      const state = workflows.of(issue);
      out.push({ id: issue._id, key: issue.key, title: issue.title, label: `${issue.key} · ${issue.title} (${state.name})`, icon: statusIcon(state.status, state.color), cls: mentionClass(state.status) });
    }
    return out;
  }

  /** Short check text for the row; the full sentence is the tooltip. */
  function checksShort(c: NonNullable<PrListItem['checks']>) {
    if (c.failed) return t('{count} failed', { count: c.failed });
    if (c.pending) return tn(c.pending, '{count} running', '{count} running');
    return t('{count} passed', { count: c.total });
  }

  const shortRepo = (repo: string) => repo.split('/')[1] ?? repo;
  const owner = (repo: string) => (repo.includes('/') ? `${repo.split('/')[0]}/` : '');
  const isShown = (pr: PrListItem) => prSlice.current?.repo === pr.repo && prSlice.current?.number === pr.number;

  function show(pr: PrListItem, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.pulls.open(pr.id);
  }
  function openIssue(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    app.openIssue(id as IssueId);
  }

  // J/K: keep the focused row in view.
  let scroller = $state<HTMLElement>();
  $effect(() => {
    const id = s.focus;
    if (!id || !scroller) return;
    scroller.querySelector<HTMLElement>(`[data-pr-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  let reloading = $state(false);
  async function reload() {
    if (reloading) return;
    reloading = true;
    try {
      const result = await app.pulls.refresh(undefined, true);
      if (result?.error) app.toasts.show(t('Pull requests not updated'), undefined, 'error', result.error);
    } catch (error) {
      app.toasts.error(t('Pull requests not updated'), error);
    } finally {
      reloading = false;
    }
  }
</script>

<PrHost list>
  <header class="location-bar pr-bar">
    <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
    <div class="crumbs"><span class="crumb"><span class="icon">{@html ICON.pr}</span><span class="crumb-title">{t('Pull requests')}</span></span></div>
    {#if s.loaded && count > 0}<span class="bar-count" data-testid="pulls-total">{count}</span>{/if}
    <span class="bar-spacer"></span>
    {#if s.configured && count > 0}
      <button class={['icon-btn', 'plain', reloading && 'spinning']} title={t('Reload from GitHub')} aria-label={t('Reload from GitHub')} data-testid="pulls-reload" onclick={() => void reload()}><span class="icon">{@html ICON.redo}</span></button>
    {/if}
  </header>

  <div class="pulls-scroll" bind:this={scroller} data-testid="pulls-page">
    {#if !s.loaded}
      <div class="pulls-content"><div class="pr-skeleton"></div><div class="pr-skeleton short"></div></div>
    {:else if s.groups.length === 0}
      <div class="empty" data-testid="pulls-empty">
        <div class="empty-icon"><span class="icon">{@html ICON.pr}</span></div>
        <div class="empty-text">{t('No pull requests are linked to an issue yet. A pull request is linked when its branch name, title or description contains an issue identifier such as {example}.', { example })}</div>
        <a class="btn" href={DOCS.githubLinks} target="_blank" rel="noopener noreferrer">{t('How linking works')}</a>
      </div>
    {:else}
      <div class="pulls-content">
        {#if !s.configured}
          <p class="pulls-note" data-testid="pulls-unconfigured">
            {t('Without a GitHub token Selfbound knows only title and state, so checks and reviews are missing.')}
            <a href={DOCS.github} target="_blank" rel="noopener noreferrer">{t('How to set it up')}</a>
          </p>
        {/if}
        {#each s.groups as g (g.group)}
          <section class="pulls-group" data-testid="pulls-group" data-group={g.group} aria-label={GROUP_LABEL[g.group]}>
            {#if g.group === 'done'}
              <button class="group-box pulls-head" style:--tint={GROUP_TINT[g.group]} aria-expanded={!g.collapsed} title={tip(t('Show or hide merged and closed pull requests'), 'pulls.done')} data-testid="pulls-done-toggle" onclick={() => app.pulls.toggleDone()}>
                <span class={['group-chevron', g.collapsed && 'closed']} aria-hidden="true"><span class="icon mi ui-caretDown"></span></span>
                <span>{GROUP_LABEL[g.group]}</span>
                <span class="group-count">{g.items.length}</span>
                <span class="pulls-head-note">{t('last 14 days')}</span>
              </button>
            {:else}
              <h2 class="group-box pulls-head" style:--tint={GROUP_TINT[g.group]}>
                <span class="pulls-dot" aria-hidden="true"></span>
                <span>{GROUP_LABEL[g.group]}</span>
                <span class="group-count">{g.items.length}</span>
              </h2>
            {/if}
            {#if !g.collapsed}
              {#each g.items as pr (pr.id)}
                {@const linked = issues(pr)}
                {@const active = isShown(pr)}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class={['pull-row', active && 'active', s.focus === pr.id && 'focused']} data-testid="pull-row" data-pr-id={pr.id} data-pr={`${pr.repo}#${pr.number}`} onclick={(e) => show(pr, e)}>
                  <span class={['icon', 'pr-icon', 'pull-icon', `is-${pr.state}`]} title={STATE_LABEL[pr.state]}>{@html ICON.pr}</span>
                  <span class="pull-title" title={pr.title}>{pr.title}</span>
                  <span class="pull-sub">
                    <a class="pull-key" href="/pr/{pr.repo}/{pr.number}" aria-current={active ? 'true' : undefined} title={pr.repo}><span class="pull-owner">{owner(pr.repo)}</span>{shortRepo(pr.repo)}#{pr.number}</a>
                    <span class="pull-extra">
                      {#each linked.slice(0, CHIPS_MAX) as issue (issue.id)}
                        <a class={['pull-issue', issue.cls]} href="/issue/{issue.key}" title={issue.label} aria-label={issue.label} data-testid="pull-issue" onclick={(e) => openIssue(issue.id, e)}><span class="icon">{@html issue.icon}</span>{issue.key}</a>
                      {/each}
                      {#if linked.length > CHIPS_MAX}
                        <span class="pull-more" title={linked.slice(CHIPS_MAX).map((i) => i.label).join('\n')}>+{linked.length - CHIPS_MAX}</span>
                      {/if}
                      {#each pr.blockers ?? [] as blocker (blocker)}
                        <span class={['pill', 'pull-blocker', blocker]} data-testid="pull-blocker">{BLOCKER_LABEL[blocker]}</span>
                      {/each}
                      {#if pr.review === 'approved'}
                        <span class="pr-review approved" title={t('Approved')}><span class="icon">{@html ICON.check}</span></span>
                      {/if}
                      {#if pr.checks && pr.checks.total && g.group !== 'done'}
                        <span class="pull-checks" title={checksText(pr.checks)} data-testid="pull-checks">
                          <span class={['pr-dot', pr.checks.failed ? 'failure' : pr.checks.pending ? 'pending' : 'success']} aria-hidden="true"></span>{checksShort(pr.checks)}
                        </span>
                      {/if}
                    </span>
                  </span>
                  <span class="pull-age" title={fullDate(pr.updatedAt)}>{g.group === 'done' ? STATE_LABEL[pr.state] + ' · ' : ''}{relativeTime(pr.updatedAt)}</span>
                </div>
              {/each}
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  </div>
</PrHost>
