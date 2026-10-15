<script lang="ts">
  // Sources of a knowledge page: list with URL or title, author, publication and access date, note.
  // Add, edit, move up/down, remove.
  import { ICON, today, type ArticleView, type SourceInput } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';

  type Source = ArticleView['sources'][number];
  let { article: a }: { article: ArticleView } = $props();
  /** Being edited: id of a source or 'new' */
  let editing = $state<string | null>(null);
  let form = $state<Required<{ [K in keyof SourceInput]: string }>>({ url: '', title: '', author: '', publishedAt: '', accessedAt: '', note: '' });
  let busy = $state(false);

  function start(source: Source | null) {
    editing = source?.id ?? 'new';
    form = {
      url: source?.url ?? '',
      title: source?.title ?? '',
      author: source?.author ?? '',
      publishedAt: source?.publishedAt ?? '',
      accessedAt: source?.accessedAt ?? today(),
      note: source?.note ?? '',
    };
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (busy || !editing) return;
    busy = true;
    const value = (v: string) => v.trim();
    const ok =
      editing === 'new'
        ? await app.wiki.addSource(a.id, {
            ...(value(form.url) ? { url: value(form.url) } : {}),
            ...(value(form.title) ? { title: value(form.title) } : {}),
            ...(value(form.author) ? { author: value(form.author) } : {}),
            ...(value(form.publishedAt) ? { publishedAt: value(form.publishedAt) } : {}),
            ...(value(form.accessedAt) ? { accessedAt: value(form.accessedAt) } : {}),
            ...(value(form.note) ? { note: value(form.note) } : {}),
          })
        : await app.wiki.updateSource(editing, {
            url: value(form.url) || null,
            title: value(form.title) || null,
            author: value(form.author) || null,
            publishedAt: value(form.publishedAt) || null,
            ...(value(form.accessedAt) ? { accessedAt: value(form.accessedAt) } : {}),
            note: value(form.note) || null,
          });
    busy = false;
    if (ok) editing = null;
  }

  const meta = (s: Source) => [s.author, s.publishedAt, t('accessed {date}', { date: s.accessedAt })].filter(Boolean).join(' · ');
</script>

{#snippet editor()}
  <form class="wiki-source-form" data-testid="source-form" onsubmit={save}>
    <input class="input" placeholder={t('URL (https://…)')} bind:value={form.url} data-testid="source-url" />
    <input class="input" placeholder={t('Title (required without a URL)')} bind:value={form.title} data-testid="source-title" />
    <div class="wiki-source-row">
      <input class="input" placeholder={t('Author or publisher')} bind:value={form.author} data-testid="source-author" />
      <input class="input short" placeholder={t('Published: YYYY(-MM(-DD))')} bind:value={form.publishedAt} data-testid="source-published" />
      <input class="input short" type="date" aria-label={t('Accessed on')} bind:value={form.accessedAt} data-testid="source-accessed" />
    </div>
    <input class="input" placeholder={t('Note (what the source supports)')} bind:value={form.note} data-testid="source-note" />
    <div class="wiki-source-row end">
      <button type="button" class="btn ghost small" onclick={() => (editing = null)}>{t('Cancel')}</button>
      <button type="submit" class="btn primary small" disabled={busy || (!form.url.trim() && !form.title.trim())} data-testid="source-save">{t('Save')}</button>
    </div>
  </form>
{/snippet}

<div class="section-title">
  {t('Sources')}
  <span class="bar-spacer"></span>
  {#if !a.deleted && editing !== 'new'}
    <button class="btn ghost small" data-testid="source-add" onclick={() => start(null)}><span class="icon">{@html ICON.plus}</span>{t('Add source')}</button>
  {/if}
</div>
{#if a.sources.length === 0 && editing !== 'new'}
  <div class="wiki-empty-line">{t('No sources yet.')}</div>
{/if}
<ol class="wiki-sources" data-testid="article-sources">
  {#each a.sources as src, i (src.id)}
    <li data-testid="source">
      {#if editing === src.id}
        {@render editor()}
      {:else}
        <div class="wiki-source">
          <span class="grow">
            {#if src.url}<a href={src.url} target="_blank" rel="noopener noreferrer">{src.title ?? src.url}</a>{:else}{src.title}{/if}
            <span class="muted">{meta(src)}</span>
            {#if src.note}<div class="muted">{src.note}</div>{/if}
          </span>
          {#if !a.deleted}
            <span class="wiki-source-tools">
              <button class="icon-btn plain" aria-label={t('Move up')} title={t('Move up')} disabled={i === 0} onclick={() => void app.wiki.moveSource(a.id, src.id, -1)}><span class="icon">{@html ICON.arrowUp}</span></button>
              <button class="icon-btn plain" aria-label={t('Move down')} title={t('Move down')} disabled={i === a.sources.length - 1} onclick={() => void app.wiki.moveSource(a.id, src.id, 1)}><span class="icon">{@html ICON.arrowDown}</span></button>
              <button class="icon-btn plain" aria-label={t('Edit')} title={t('Edit')} data-testid="source-edit" onclick={() => start(src)}><span class="icon">{@html ICON.edit}</span></button>
              <button class="icon-btn plain" aria-label={t('Remove')} title={t('Remove')} data-testid="source-remove" onclick={() => void app.wiki.removeSource(src.id)}><span class="icon">{@html ICON.close}</span></button>
            </span>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ol>
{#if editing === 'new'}{@render editor()}{/if}
