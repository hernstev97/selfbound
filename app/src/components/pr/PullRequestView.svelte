<script lang="ts">
  // A pull request in Selfbound: state, checks, description, comments and reviews, merge, close/reopen,
  // comment. As its own page (/pr/<owner>/<repo>/<nr>) or beside the issue. Data: subscription
  // `githubPr.view`; on open `githubPr.refresh` fetches the state from GitHub, afterwards webhooks
  // keep it current. The code diff stays on GitHub (link to the changed files).
  import '../../styles/pr.css';
  import { api } from '@selfbound/backend/api';
  import type { Id } from '@selfbound/backend/dataModel';
  import { checkCounts, type MergeMethod, type PrCheck, type PrItem, type PrView } from '@selfbound/backend/shared/pullRequests';
  import { ICON, fullDate, relativeTime } from '@selfbound/core';
  import { t, tn } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TextEditor from '../TextEditor.svelte';
  import PrHtml from './PrHtml.svelte';
  import ImageViewer, { type ViewerImage } from './ImageViewer.svelte';
  import { CHECK_LABEL, METHOD_LABEL, STATE_LABEL, checksText, mergeHint, reviewLabel } from './prText.ts';

  interface Props {
    repo: string;
    number: number;
    mode: 'page' | 'split';
  }
  let { repo, number, mode }: Props = $props();

  const shellSlice = fromSlice(app.shell);
  let view = $state<PrView | null | undefined>(undefined);

  $effect(() => {
    const watch = app.store.watch(api.githubPr.view, { repo, number });
    const update = () => (view = watch.slice.get() as PrView | null | undefined);
    update();
    const stop = watch.slice.subscribe(update);
    return () => {
      stop();
      watch.release();
      view = undefined;
    };
  });

  // Refresh once on open (the server fetches only if the state is older than 30 s).
  let refreshing = $state(false);
  let refreshedFor = '';
  async function refresh(maxAgeMs = 30_000) {
    if (!view || !view.configured || refreshing) return;
    refreshing = true;
    try {
      const result = await app.store.act(api.githubPr.refresh, { prIds: [view.pr.id as Id<'pullRequests'>], maxAgeMs });
      if (result.error && maxAgeMs === 0) app.toasts.show(t('Pull request not updated'), undefined, 'error', result.error);
    } catch (error) {
      if (maxAgeMs === 0) app.toasts.error(t('Pull request not updated'), error);
    } finally {
      refreshing = false;
    }
  }
  $effect(() => {
    const id = view?.pr.id;
    if (!id || refreshedFor === id) return;
    refreshedFor = id;
    void refresh();
  });

  const pr = $derived(view?.pr);
  const detail = $derived(view?.detail ?? null);
  const counts = $derived(detail ? checkCounts(detail.checks) : null);
  const open = $derived(pr?.state === 'open' || pr?.state === 'draft');
  const repoName = $derived(repo.split('/')[1] ?? repo);

  // ---- Checks: expanded as soon as something fails or runs
  let checksOpen = $state<boolean | null>(null);
  const checksShown = $derived(checksOpen ?? (counts ? counts.failed + counts.pending > 0 : false));
  const sortedChecks = $derived.by(() => {
    const order: Record<PrCheck['state'], number> = { failure: 0, pending: 1, cancelled: 2, success: 3, neutral: 4, skipped: 5 };
    return [...(detail?.checks ?? [])].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  });

  // ---- Merge
  const METHOD_KEY = 'selfbound:prMergeMethod';
  let method = $state<MergeMethod>((globalThis.localStorage?.getItem(METHOD_KEY) as MergeMethod | null) ?? 'squash');
  const methods = $derived(detail?.mergeMethods.length ? detail.mergeMethods : (['merge'] as MergeMethod[]));
  const chosen = $derived(methods.includes(method) ? method : methods[0]!);
  let deleteBranch = $state(true);
  let confirming = $state(false);
  let busy = $state<'merge' | 'state' | 'comment' | null>(null);
  const canMerge = $derived(!!detail && pr?.state === 'open' && detail.mergeState !== 'dirty' && detail.mergeState !== 'draft' && detail.mergeState !== 'blocked');

  async function merge() {
    if (!pr || !detail) return;
    busy = 'merge';
    try {
      globalThis.localStorage?.setItem(METHOD_KEY, chosen);
      const result = await app.store.act(api.githubPr.merge, {
        prId: pr.id as Id<'pullRequests'>,
        method: chosen,
        deleteBranch: deleteBranch && detail.headBranchDeletable && !detail.deleteBranchOnMerge,
      });
      const text = result.branchDeleted ? t('#{number} merged, branch deleted', { number: pr.number }) : t('#{number} merged', { number: pr.number });
      // A notice from the server (e.g. the branch could not be deleted) stays longer.
      if (result.message) app.toasts.show(text, undefined, 'info', result.message, 8000);
      else app.toasts.show(text);
      confirming = false;
    } catch (error) {
      app.toasts.error(t('Not merged'), error);
    } finally {
      busy = null;
    }
  }

  async function setState(state: 'open' | 'closed') {
    if (!pr) return;
    busy = 'state';
    try {
      await app.store.act(api.githubPr.setState, { prId: pr.id as Id<'pullRequests'>, state });
      app.toasts.show(state === 'closed' ? t('#{number} closed', { number: pr.number }) : t('#{number} reopened', { number: pr.number }));
    } catch (error) {
      app.toasts.error(state === 'closed' ? t('Not closed') : t('Not reopened'), error);
    } finally {
      busy = null;
    }
  }

  // ---- Comment (the view is rebuilt per pull request, {#key} in the caller)
  let draft = $state('');

  async function comment() {
    if (!pr || !draft.trim() || busy) return;
    busy = 'comment';
    const body = draft;
    try {
      await app.store.act(api.githubPr.comment, { prId: pr.id as Id<'pullRequests'>, body });
      if (draft === body) draft = '';
    } catch (error) {
      app.toasts.error(t('Comment not sent'), error);
    } finally {
      busy = null;
    }
  }

  // ---- Long posts (e.g. bots) collapsed
  const LONG = 2500;
  let expanded = $state<Record<string, boolean>>({});
  const isLong = (item: PrItem) => item.html.length > LONG;

  function verb(item: PrItem) {
    if (item.kind === 'review') return reviewLabel(item.reviewState);
    if (item.kind === 'review_comment') return item.replyTo ? t('replied') : t('commented on the code');
    return t('commented');
  }

  function close() {
    app.prSplit.set(null);
  }
  // ---- Image viewer (click on an image in the description or timeline)
  let viewer = $state<{ images: ViewerImage[]; index: number } | null>(null);
  const onimage = (images: ViewerImage[], index: number) => (viewer = { images, index });

  function openFull() {
    // The split closes by itself on a page change (App.onPage).
    app.nav.go({ name: 'pr', repo, number });
  }

  // Sentences with code values ({head}, {base}, {token}): the placeholder becomes a marker, the
  // template splits there and renders the value as <code>. Odd parts are placeholder names.
  const slot = (name: string) => `\u0001${name}\u0001`;
  const parts = (text: string) => text.split('\u0001');
</script>

<header class={['location-bar', 'pr-bar']} data-testid={mode === 'split' ? 'pr-split-bar' : 'pr-bar'}>
  {#if mode === 'page'}
    <button class="icon-btn plain mobile-only" aria-label={t('Back')} onclick={() => app.closeIssue()}><span class="icon">{@html ICON.back}</span></button>
  {/if}
  <div class="crumbs">
    <span class="crumb"><span class="icon">{@html ICON.github}</span><span class="crumb-title">{repoName}</span></span>
    <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
    <span class="crumb"><span class="crumb-title tnum">#{number}</span></span>
  </div>
  <span class="bar-spacer"></span>
  {#if view?.configured}
    <button class={['icon-btn', 'plain', refreshing && 'spinning']} title={t('Reload from GitHub')} aria-label={t('Reload from GitHub')} data-testid="pr-refresh" onclick={() => void refresh(0)}><span class="icon">{@html ICON.redo}</span></button>
  {/if}
  {#if pr}
    <a class="icon-btn plain" href={pr.url} target="_blank" rel="noopener noreferrer" title={t('Open on GitHub')} aria-label={t('Open on GitHub')}><span class="icon">{@html ICON.open}</span></a>
  {/if}
  {#if mode === 'split'}
    <button class="icon-btn plain" title={t('Open full size')} aria-label={t('Open full size')} data-testid="pr-full" onclick={openFull}><span class="icon">{@html ICON.expand}</span></button>
    <button class="icon-btn plain" title={t('Close (Esc)')} aria-label={t('Close')} data-testid="pr-close" onclick={close}><span class="icon">{@html ICON.close}</span></button>
  {/if}
</header>

<div class={['pr-scroll', mode === 'split' && 'in-split']} data-testid="pr-view">
  {#if view === undefined}
    <div class="pr-content"><div class="pr-skeleton"></div><div class="pr-skeleton short"></div></div>
  {:else if view === null || !pr}
    <div class="detail-missing" data-testid="pr-missing">
      <div class="empty-icon"><span class="icon">{@html ICON.pr}</span></div>
      <div>{t('{pr} is not known in Selfbound. Pull requests appear here once they are linked to an issue.', { pr: `${repo}#${number}` })}</div>
      <a class="btn" href="https://github.com/{repo}/pull/{number}" target="_blank" rel="noopener noreferrer">{t('Open on GitHub')}</a>
    </div>
  {:else}
    <div class="pr-content">
      <h1 class="pr-title" data-testid="pr-title">{pr.title} <span class="pr-num">#{pr.number}</span></h1>

      <div class="pr-meta">
        <span class={['pr-state', `is-${pr.state}`]} data-testid="pr-state"><span class="icon">{@html ICON.pr}</span>{STATE_LABEL[pr.state]}</span>
        {#if detail?.mergeState === 'dirty' && open}
          <span class="pr-state is-conflict" data-testid="pr-conflict"><span class="icon">{@html ICON.warning}</span>{t('Conflicts')}</span>
        {/if}
        {#if detail}
          <span class="pr-person">
            {#if detail.author.avatarUrl}<img class="pr-avatar" src="{detail.author.avatarUrl}&s=40" alt="" referrerpolicy="no-referrer" />{/if}
            <strong>{detail.author.login}</strong>
          </span>
          {@const refs = { head: `${detail.headRepo && detail.headRepo !== pr.repo ? `${detail.headRepo.split('/')[0]}:` : ''}${detail.headRef}`, base: detail.baseRef } as Record<string, string>}
          {@const sentence =
            pr.state === 'merged'
              ? tn(detail.commits, 'merged {count} commit from {head} into {base}', 'merged {count} commits from {head} into {base}', { head: slot('head'), base: slot('base') })
              : tn(detail.commits, 'wants to merge {count} commit from {head} into {base}', 'wants to merge {count} commits from {head} into {base}', { head: slot('head'), base: slot('base') })}
          <span class="muted">
            {#each parts(sentence) as part, i (i)}{#if i % 2}<code class="pr-ref">{refs[part]}</code>{:else}{part}{/if}{/each}
          </span>
        {:else}
          <span class="muted"><code class="pr-ref">{pr.branch}</code>{#if pr.author} · {pr.author}{/if}</span>
        {/if}
      </div>

      {#if detail}
        <div class="pr-meta second">
          <a class="pr-files" href="{pr.url}/files" target="_blank" rel="noopener noreferrer" title={t('View code changes on GitHub')} data-testid="pr-files">
            <span class="add">+{detail.additions}</span> <span class="del">−{detail.deletions}</span>
            <span>{tn(detail.changedFiles, '{count} file on GitHub', '{count} files on GitHub')}</span>
            <span class="icon">{@html ICON.open}</span>
          </a>
          {#each detail.labels as label (label.name)}
            <span class="pr-label" style:--label="#{label.color}">{label.name}</span>
          {/each}
          {#if detail.requestedReviewers.length}
            <span class="muted">{t('Review requested from {names}', { names: detail.requestedReviewers.map((r) => r.login).join(', ') })}</span>
          {/if}
        </div>
      {/if}

      {#if !view.configured}
        <div class="pr-notice" data-testid="pr-unconfigured">
          {#each parts(t('GitHub access is not set up: Selfbound only knows the title and state from the webhook. Description, checks, comments and actions need {token} in the backend (docs/operations.md).', { token: slot('token') })) as part, i (i)}{#if i % 2}<code>GITHUB_TOKEN</code>{:else}{part}{/if}{/each}
        </div>
      {:else if detail?.error}
        <div class="pr-notice error" data-testid="pr-error">{detail.error} <span class="muted">{t('As of {when}.', { when: relativeTime(detail.fetchedAt) })}</span></div>
      {:else if !detail && view.error}
        <div class="pr-notice error" data-testid="pr-error">{view.error}</div>
      {:else if !detail}
        <div class="pr-notice">{t('Loading from GitHub …')}</div>
      {/if}

      <!-- Box: checks, mergeability, actions -->
      {#if detail || view.configured}
        <section class="pr-box" data-testid="pr-box">
          {#if detail && detail.checks.length && counts}
            <button class="pr-box-row pr-checks-head" aria-expanded={checksShown} onclick={() => (checksOpen = !checksShown)} data-testid="pr-checks-toggle">
              <span class={['pr-dot', counts.failed ? 'failure' : counts.pending ? 'pending' : 'success']}></span>
              <span class="grow">
                {checksText(counts)}
              </span>
              <span class={['icon', 'chev', checksShown && 'open']}>{@html ICON.chevronRight}</span>
            </button>
            {#if checksShown}
              <ul class="pr-checks" data-testid="pr-checks">
                {#each sortedChecks as check (check.key)}
                  <li class="pr-check">
                    <span class={['pr-dot', check.state]} title={CHECK_LABEL[check.state]}></span>
                    <span class="name">{check.name}</span>
                    {#if check.app}<span class="muted app">{check.app}</span>{/if}
                    {#if check.summary}<span class="muted summary">{check.summary}</span>{/if}
                    <span class="grow"></span>
                    {#if check.completedAt}<span class="muted when" title={fullDate(check.completedAt)}>{relativeTime(check.completedAt)}</span>{/if}
                    {#if check.url}<a class="btn ghost small" href={check.url} target="_blank" rel="noopener noreferrer">{check.source === 'check' && check.app === 'GitHub Actions' ? t('Log') : t('Details')}</a>{/if}
                  </li>
                {/each}
              </ul>
            {/if}
          {:else if detail}
            <div class="pr-box-row muted"><span class="pr-dot neutral"></span>{t('No checks for the last commit.')}</div>
          {/if}

          {#if detail}
            <div class="pr-box-row" data-testid="pr-merge-state">
              <span class={['pr-dot', pr.state === 'merged' ? 'merged' : !open ? 'neutral' : detail.mergeState === 'clean' ? 'success' : detail.mergeState === 'dirty' || detail.mergeState === 'blocked' ? 'failure' : 'pending']}></span>
              <span class="grow">{mergeHint(pr, detail)}</span>
            </div>
          {/if}

          {#if view.configured && detail}
            <div class="pr-actions" data-testid="pr-actions">
              {#if pr.state === 'open' || pr.state === 'draft'}
                {#if confirming}
                  <span class="grow confirm-text">{#each parts(t('{method} into {base}?', { method: METHOD_LABEL[chosen], base: slot('base') })) as part, i (i)}{#if i % 2}<code class="pr-ref">{detail.baseRef}</code>{:else}{part}{/if}{/each}</span>
                  <button class="btn small primary" disabled={busy !== null} data-testid="pr-merge-confirm" onclick={() => void merge()}>{busy === 'merge' ? t('Merging …') : t('Yes, merge')}</button>
                  <button class="btn small ghost" disabled={busy === 'merge'} onclick={() => (confirming = false)}>{t('Cancel')}</button>
                {:else}
                  <select class="pr-method" value={chosen} onchange={(e) => (method = (e.currentTarget as HTMLSelectElement).value as MergeMethod)} aria-label={t('Merge method')} data-testid="pr-method" disabled={!canMerge}>
                    {#each methods as m (m)}<option value={m}>{METHOD_LABEL[m]}</option>{/each}
                  </select>
                  <button class="btn small primary" disabled={!canMerge || busy !== null} data-testid="pr-merge" onclick={() => (confirming = true)}>{t('Merge')}</button>
                  {#if detail.deleteBranchOnMerge}
                    <span class="muted small-note">{t('The branch is deleted afterwards')}</span>
                  {:else if detail.headBranchDeletable}
                    <label class="pr-check-label"><input type="checkbox" bind:checked={deleteBranch} data-testid="pr-delete-branch" /> {t('Delete branch')}</label>
                  {/if}
                  <span class="grow"></span>
                  <button class="btn small ghost" disabled={busy !== null} data-testid="pr-close-pr" onclick={() => void setState('closed')}>{busy === 'state' ? t('Closing …') : t('Close pull request')}</button>
                {/if}
              {:else if pr.state === 'closed'}
                <span class="grow"></span>
                <button class="btn small" disabled={busy !== null} data-testid="pr-reopen" onclick={() => void setState('open')}>{busy === 'state' ? t('Reopening …') : t('Reopen')}</button>
              {/if}
            </div>
          {/if}
        </section>
      {/if}

      {#if detail}
        <div class="pr-desc" data-testid="pr-description">
          {#if detail.bodyHtml.trim()}
            <PrHtml html={detail.bodyHtml} {onimage} />
          {:else}
            <p class="muted">{t('No description.')}</p>
          {/if}
        </div>
      {/if}

      {#if view.items.length || view.configured}
        <div class="section-title">{t('Activity')} <span class="muted">{view.items.length || ''}</span></div>
        <ol class="pr-timeline" data-testid="pr-timeline">
          {#each view.items as item (item.key)}
            <li class={['pr-item', `kind-${item.kind}`, item.replyTo && 'reply', item.reviewState && `review-${item.reviewState}`]} data-testid="pr-item">
              <div class="pr-item-head">
                {#if item.author.avatarUrl}<img class="pr-avatar" src="{item.author.avatarUrl}&s=40" alt="" referrerpolicy="no-referrer" />{/if}
                <strong>{item.author.login}</strong>
                {#if item.author.bot}<span class="pr-bot">{t('Bot')}</span>{/if}
                <span class={['muted', item.reviewState && 'review-verb']}>{verb(item)}</span>
                {#if item.path}<code class="pr-ref" title={item.path}>{item.path.split('/').at(-1)}{item.line ? `:${item.line}` : ''}</code>{/if}
                <a class="muted when" href={item.url} target="_blank" rel="noopener noreferrer" title={fullDate(item.createdAt)}>{relativeTime(item.createdAt)}</a>
              </div>
              {#if item.html.trim()}
                <div class={['pr-item-body', isLong(item) && !expanded[item.key] && 'clamped']}>
                  <PrHtml html={item.html} {onimage} />
                </div>
                {#if isLong(item)}
                  <button class="btn ghost small pr-more" onclick={() => (expanded[item.key] = !expanded[item.key])}>{expanded[item.key] ? t('Show less') : t('Show all')}</button>
                {/if}
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      {#if view.configured}
        <div class="comment-box pr-comment">
          <TextEditor
            class="comment-input"
            testid="pr-comment-input"
            label={t('Comment on GitHub')}
            placeholder={t('Write a comment on GitHub …')}
            value={draft}
            onchange={(text) => (draft = text)}
            onsubmit={() => {
              void comment();
              return true;
            }}
          />
          <div class="comment-box-foot">
            <span>{shellSlice.current.mobile ? '' : `${t('Ctrl Enter to send')} · `}{t('appears on GitHub under your name')}</span>
            <button class="btn small primary" data-testid="pr-comment-send" disabled={!draft.trim() || busy !== null} onclick={() => void comment()}>{busy === 'comment' ? t('Sending …') : t('Comment')}</button>
          </div>
        </div>
      {/if}

      {#if detail}
        <div class="pr-foot muted">{t('Last fetched from GitHub: {when}', { when: relativeTime(detail.fetchedAt) })}{refreshing ? ` · ${t('updating …')}` : ''}</div>
      {/if}
    </div>
  {/if}
</div>

{#if viewer}
  <ImageViewer images={viewer.images} bind:index={viewer.index} onclose={() => (viewer = null)} />
{/if}
