<script lang="ts">
  // Knowledge area of a team: the page tree on the left, the selected page or an overview on the
  // right. /team/KEY/wiki and /wiki/<id> show the same page.
  import '../../styles/detail.css';
  import '../../styles/wiki.css';
  import { ICON } from '@selfbound/core';
  import { intlLocale, t, tn } from '@selfbound/core/i18n';
  import { tick } from 'svelte';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import TeamLogo from '../../components/TeamLogo.svelte';
  import ArticleBody from './ArticleBody.svelte';
  import ArticleMentions from './ArticleMentions.svelte';
  import ArticleProps from './ArticleProps.svelte';
  import ArticleRevisions from './ArticleRevisions.svelte';
  import ArticleSources from './ArticleSources.svelte';
  import WikiTree from './WikiTree.svelte';

  const wikiSlice = fromSlice(app.wiki.state);
  const s = $derived(wikiSlice.current);
  const a = $derived(s.article ?? null);

  let showRevisions = $state(false);
  // Close only when the page changes, not on every new revision of the same page.
  const shownId = $derived(a?.id ?? null);
  $effect(() => {
    void shownId;
    showRevisions = false;
  });
  let title = $state('');
  let editingTitle = $state(false);
  /** Title sent, until the server confirms it (otherwise the old one would show briefly). */
  let sentTitle = $state<string | null>(null);
  $effect(() => {
    if (!editingTitle && a && sentTitle === null) title = a.title;
  });
  let titleField = $state<HTMLTextAreaElement>();
  // New page: title selected so that typing replaces it (core creates it with t('New page')).
  let fresh: string | null = null;
  $effect(() => {
    if (a && a.title === t('New page') && !a.body.markdown && fresh !== a.id && titleField) {
      fresh = a.id;
      const field = titleField;
      void tick().then(() => {
        field.focus();
        field.select();
      });
    }
  });
  function saveTitle() {
    editingTitle = false;
    if (!a) return;
    sentTitle = title;
    void app.wiki.rename(a.id, title).finally(() => (sentTitle = null));
  }
  const go = (e: MouseEvent, run: () => void) => {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    run();
  };
</script>

<header class="location-bar" data-testid="location-bar">
  <button class="icon-btn plain mobile-only" aria-label={t('Navigation')} onclick={() => app.toggleSidebar()}><span class="icon">{@html ICON.menu}</span></button>
  <div class="crumbs">
    {#if s.team}
      <a class="crumb" href="/team/{s.team.key}/wiki" onclick={(e) => go(e, () => app.nav.go({ name: 'wiki', team: s.team!.key }))}>
        <TeamLogo team={s.team} size={14} /><span class="crumb-title">{s.team.name}</span>
      </a>
      <span class="icon crumb-sep">{@html ICON.chevronRight}</span>
    {/if}
    <a class="crumb" href={s.team ? `/team/${s.team.key}/wiki` : '#'} onclick={(e) => go(e, () => s.team && app.nav.go({ name: 'wiki', team: s.team.key }))}>
      <span class="icon">{@html ICON.wiki}</span><span class="crumb-title">{t('Knowledge')}</span>
    </a>
    {#if a}
      {#each a.path as p (p.id)}
        <span class="icon crumb-sep desktop-only">{@html ICON.chevronRight}</span>
        <a class="crumb desktop-only" href="/wiki/{p.id}" onclick={(e) => go(e, () => app.wiki.open(p.id))}><span class="crumb-title">{p.title}</span></a>
      {/each}
    {/if}
  </div>
  <span class="bar-spacer"></span>
  {#if s.enabled}
    <button class="btn ghost small" aria-label={t('Deleted pages')} data-testid="wiki-trash" onclick={() => (s.trash === false ? app.wiki.openTrash() : app.wiki.closeTrash())}>
      <span class="icon">{@html ICON.trash}</span><span class="btn-label">{t('Deleted')}</span>
    </button>
    {#if a && !a.deleted}
      <button class={['btn ghost small', showRevisions && 'on']} aria-label={t('Revisions')} aria-pressed={showRevisions} data-testid="article-revisions-toggle" onclick={() => (showRevisions = !showRevisions)}><span class="icon">{@html ICON.restore}</span><span class="btn-label">{t('Revisions')}</span></button>
      <button class="icon-btn plain" title={t('Copy link')} aria-label={t('Copy link')} data-testid="article-copy-link" onclick={() => { void navigator.clipboard?.writeText(`${location.origin}/wiki/${a!.id}`); app.toasts.show(t('Link copied')); }}><span class="icon">{@html ICON.link}</span></button>
      <button class="icon-btn plain" title={t('Move to trash')} aria-label={t('Move to trash')} data-testid="article-remove" onclick={() => void app.wiki.remove(a!.id)}><span class="icon">{@html ICON.trash}</span></button>
    {/if}
    <button class="btn small" aria-label={t('New page')} data-testid="wiki-new" onclick={() => void app.wiki.create(null)}><span class="icon">{@html ICON.plus}</span><span class="btn-label">{t('New page')}</span></button>
  {/if}
</header>

<div class="wiki" data-testid="wiki-page">
  {#if s.team && !s.enabled}
    <div class="page"><div class="page-content">
      <div class="empty" data-testid="wiki-disabled">
        <div class="empty-icon"><span class="icon">{@html ICON.wiki}</span></div>
        <div class="empty-text">{t('{team} has no knowledge area yet. In it you collect knowledge and documentation as pages, nested too.', { team: s.team.name })}</div>
        <button class="btn" data-testid="wiki-enable" onclick={() => void app.wiki.enable(s.team!.id, true)}>{t('Turn on knowledge')}</button>
      </div>
    </div></div>
  {:else}
    <aside class="wiki-side">
      <WikiTree state={s} />
    </aside>
    <div class="wiki-main">
      {#if s.trash !== false}
        <div class="wiki-content" data-testid="wiki-trash-list">
          <h1 class="page-title">{t('Deleted pages')}</h1>
          <p class="page-lead">{t('After 30 days they are deleted for good. Subpages come back with their page.')}</p>
          {#if s.trash === null}
            <div class="skeleton-bar" style="width: 60%"></div>
          {:else if s.trash.length === 0}
            <div class="empty-text">{t('The trash is empty.')}</div>
          {:else}
            <div class="card-list">
              {#each s.trash as item (item.id)}
                <div class="card-row" data-testid="wiki-trash-row">
                  <span class="icon" style="color: var(--text-muted)">{@html ICON.page}</span>
                  <span class="t">{item.title}<div class="sub">{item.pages > 1 ? `${tn(item.pages - 1, 'with {count} subpage', 'with {count} subpages')} · ` : ''}{t('deleted {date}', { date: new Date(item.deletedAt).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }) })}</div></span>
                  <button class="btn small" data-testid="wiki-restore" onclick={() => void app.wiki.restore(item.id)}><span class="icon">{@html ICON.restore}</span>{t('Restore')}</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else if s.articleId && s.article === undefined}
        <div class="wiki-content"><div class="skeleton-bar" style="width: 50%; height: 22px"></div><div class="skeleton-bar" style="width: 80%; margin-top: 18px"></div></div>
      {:else if s.articleId && !a}
        <div class="wiki-content">
          <div class="empty" data-testid="article-missing">
            <div class="empty-icon"><span class="icon">{@html ICON.page}</span></div>
            <div class="empty-text">{t('This page does not exist (or no longer exists).')}</div>
          </div>
        </div>
      {:else if a}
        {#key a.id}
          <article class="wiki-content" data-testid="article" data-id={a.id}>
            {#if a.deleted}
              <div class="desc-conflict" style="margin-bottom: 16px">
                <span class="grow">{t('This page is in the trash.')}</span>
                <button class="btn small" onclick={() => void app.wiki.restore(a!.id)}>{t('Restore')}</button>
              </div>
            {/if}
            <textarea
              class="detail-title"
              data-testid="article-title"
              rows="1"
              bind:this={titleField}
              bind:value={title}
              onfocus={() => (editingTitle = true)}
              onblur={saveTitle}
              onkeydown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (e.currentTarget as HTMLTextAreaElement).blur();
                } else if (e.key === 'Escape') {
                  title = a!.title;
                }
              }}
              disabled={a.deleted}
            ></textarea>
            <div class="wiki-meta" data-testid="article-meta" title={a.body.updatedFull}>{t('Changed {time} by {actor}', { time: a.body.updated, actor: a.body.updatedBy })}</div>
            <ArticleProps article={a} state={s} />
            {#if showRevisions}<ArticleRevisions articleId={a.id} onclose={() => (showRevisions = false)} />{/if}
            <ArticleBody article={a} />
            {#if a.children.length}
              <div class="section-title">{t('Subpages')}</div>
              <div class="sub-list" data-testid="article-children">
                {#each a.children as c (c.id)}
                  <a class="sub-row" href="/wiki/{c.id}" onclick={(e) => go(e, () => app.wiki.open(c.id))}>
                    <span class="icon">{@html ICON.page}</span><span class="t">{c.title}</span>
                  </a>
                {/each}
              </div>
            {/if}
            <ArticleMentions articleId={a.id} />
            <ArticleSources article={a} />
          </article>
        {/key}
      {:else}
        <div class="wiki-content" data-testid="wiki-overview">
          <h1 class="page-title">{t('Knowledge')}</h1>
          <p class="page-lead">{s.team ? tn(s.total, '{count} page in {team}', '{count} pages in {team}', { team: s.team.name }) : tn(s.total, '{count} page', '{count} pages')}</p>
          {#if s.recent.length}
            <div class="section-title">{t('Recently changed')}</div>
            <div class="sub-list">
              {#each s.recent as r (r.id)}
                <a class="sub-row" href="/wiki/{r.id}" onclick={(e) => go(e, () => app.wiki.open(r.id))}>
                  <span class="icon">{@html ICON.page}</span><span class="t">{r.title}</span><span class="muted">{r.updated}</span>
                </a>
              {/each}
            </div>
          {:else if s.rows !== null}
            <div class="empty">
              <div class="empty-icon"><span class="icon">{@html ICON.wiki}</span></div>
              <div class="empty-text">{t('No pages yet. Create the first one; add subpages with the plus in the tree.')}</div>
              <button class="btn" data-testid="wiki-new-empty" onclick={() => void app.wiki.create(null)}>{t('New page')}</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
