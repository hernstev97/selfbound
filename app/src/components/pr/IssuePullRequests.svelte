<script lang="ts">
  // "Pull requests" section on an issue: state, checks, review and comments per pull request.
  // A click opens it beside the issue (wide) or as its own page (phone, narrow, inbox); the buttons
  // on the right open it full size or on GitHub. The summary comes from its own query, only after
  // the frame in which the issue opens (like IssueKnowledge).
  import '../../styles/pr.css';
  import { api } from '@xlr8/backend/api';
  import type { Id } from '@xlr8/backend/dataModel';
  import type { PrSummary } from '@xlr8/backend/shared/pullRequests';
  import { ICON, type PullRequestInfo } from '@xlr8/core';
  import { t, tc, tn } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { STATE_LABEL, checksText } from './prText.ts';

  let { pullRequests, split = false }: { pullRequests: PullRequestInfo[]; split?: boolean } = $props();

  const shellSlice = fromSlice(app.shell);
  const wideSlice = fromSlice(app.wide);
  const prSlice = fromSlice(app.prSplit);
  let summaries = $state<Record<string, PrSummary>>({});

  const ids = $derived(pullRequests.map((p) => p._id).join(','));
  $effect(() => {
    const prIds = ids ? (ids.split(',') as Id<'pullRequests'>[]) : [];
    if (!prIds.length) {
      summaries = {};
      return;
    }
    let stop = () => {};
    let release = () => {};
    let frame = requestAnimationFrame(() => {
      frame = 0;
      const watch = app.store.watch(api.githubPr.summaries, { prIds: prIds.slice(0, 20) });
      release = watch.release;
      const update = () => {
        const next: Record<string, PrSummary> = {};
        for (const s of (watch.slice.get() ?? []) as PrSummary[]) next[s.id] = s;
        summaries = next;
      };
      update();
      stop = watch.slice.subscribe(update);
      // Refresh the state if it is older than 2 minutes (webhooks keep it current otherwise).
      app.store.act(api.githubPr.refresh, { prIds: prIds.slice(0, 10), maxAgeMs: 120_000 }).catch(() => {});
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      stop();
      release();
    };
  });

  // If the pull request beside it does not belong to this issue (any more, J/K), it closes.
  $effect(() => {
    const open = prSlice.current;
    if (!split && open && !pullRequests.some((p) => p.repo === open.repo && p.number === open.number)) app.prSplit.set(null);
  });

  const canSplit = $derived(!split && wideSlice.current && !shellSlice.current.mobile);

  function show(pr: PullRequestInfo, e: MouseEvent) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const open = prSlice.current;
    if (!canSplit) return full(pr);
    if (open && open.repo === pr.repo && open.number === pr.number) app.prSplit.set(null);
    else app.prSplit.set({ repo: pr.repo, number: pr.number });
  }
  function full(pr: PullRequestInfo) {
    // The split closes by itself on a page change (App.onPage).
    app.nav.go({ name: 'pr', repo: pr.repo, number: pr.number });
  }

  const shortRepo = (repo: string) => repo.split('/')[1] ?? repo;
  const stateOf = (pr: PullRequestInfo) => summaries[pr._id]?.state ?? pr.state;
</script>

{#if pullRequests.length}
  <div class="section-title">{t('Pull requests')}</div>
  <div class="sub-list pr-list" data-testid="issue-prs">
    {#each pullRequests as pr (pr._id)}
      {@const s = summaries[pr._id]}
      {@const state = stateOf(pr)}
      {@const active = prSlice.current?.repo === pr.repo && prSlice.current?.number === pr.number}
      <div class={['sub-row', 'pr-row', active && 'active']} data-testid="issue-pr">
        <a class="pr-row-main" href="/pr/{pr.repo}/{pr.number}" onclick={(e) => show(pr, e)} aria-current={active ? 'true' : undefined} title={canSplit ? t('Open beside the issue') : tc('verb', 'Open')}>
          <span class={['icon', 'pr-icon', `is-${state}`]}>{@html ICON.pr}</span>
          <span class="key">{shortRepo(pr.repo)}#{pr.number}</span>
          <span class="t">{s?.title ?? pr.title}</span>
          {#if s?.checks && s.checks.total}
            <span
              class={['pr-dot', s.checks.failed ? 'failure' : s.checks.pending ? 'pending' : 'success']}
              role="img"
              aria-label={checksText(s.checks)}
              title={checksText(s.checks)}
            ></span>
          {/if}
          {#if s?.review}
            <span class={['pr-review', s.review]} title={s.review === 'approved' ? t('Approved') : t('Changes requested')}><span class="icon">{@html s.review === 'approved' ? ICON.check : ICON.warning}</span></span>
          {/if}
          {#if s?.comments}
            <span class="pr-count" title={tn(s.comments, '{count} comment', '{count} comments')}><span class="icon">{@html ICON.comment}</span>{s.comments}</span>
          {/if}
          {#if s?.mergeState === 'dirty' && (state === 'open' || state === 'draft')}
            <span class="pill pr-conflict">{t('Conflicts')}</span>
          {/if}
          <span class="pill">{STATE_LABEL[state]}</span>
        </a>
        <span class="pr-row-actions">
          <button
            class="icon-btn plain"
            title={t('Open full size')}
            aria-label={t('Open full size')}
            data-testid="issue-pr-full"
            onclick={() => full(pr)}><span class="icon">{@html ICON.expand}</span></button
          >
          <a class="icon-btn plain" href={pr.url} target="_blank" rel="noopener noreferrer" title={t('Open on GitHub')} aria-label={t('Open on GitHub')}><span class="icon">{@html ICON.open}</span></a>
        </span>
      </div>
    {/each}
  </div>
{/if}
