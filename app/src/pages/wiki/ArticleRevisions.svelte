<script lang="ts">
  // Earlier revisions of a knowledge page: list (newest first, 20 more per load), preview of a
  // revision and "Restore" (writes it as the new state, reversible).
  import { api } from '@selfbound/backend/api';
  import { intlLocale, t } from '@selfbound/core/i18n';
  import type { FunctionReturnType } from 'convex/server';
  import { actorName, fullDate, relativeTime } from '@selfbound/core';
  import { app } from '../../app-instance.ts';
  import Markdown from '../../components/Markdown.svelte';
  import { untrack } from 'svelte';

  type Page = FunctionReturnType<typeof api.wiki.revisions>;
  type Revision = FunctionReturnType<typeof api.wiki.revision>;
  let { articleId, onclose }: { articleId: string; onclose: () => void } = $props();
  let pages = $state<Page[]>([]);
  let selected = $state<string | null>(null);
  let preview = $state<Revision | undefined>(undefined);

  // First page as a subscription (new revisions show up right away), further pages loaded once.
  $effect(() => {
    const { slice, release } = app.store.watch(api.wiki.revisions, { articleId: articleId as never });
    const update = () => {
      const first = slice.get();
      if (first) pages = [first, ...untrack(() => pages).slice(1)];
    };
    update();
    const stop = slice.subscribe(update);
    return () => {
      stop();
      release();
    };
  });

  $effect(() => {
    const id = selected;
    preview = undefined;
    if (!id) return;
    const { slice, release } = app.store.watch(api.wiki.revision, { revisionId: id as never });
    const update = () => (preview = slice.get());
    update();
    const stop = slice.subscribe(update);
    return () => {
      stop();
      release();
    };
  });

  const revisions = $derived(pages.flatMap((p) => p.revisions));
  const more = $derived(pages.at(-1)?.hasMore ?? false);

  async function loadMore() {
    const before = revisions.at(-1)?.savedAt;
    if (before === undefined) return;
    const { slice, release } = app.store.watch(api.wiki.revisions, { articleId: articleId as never, before });
    const done = () => {
      const page = slice.get();
      if (!page) return false;
      pages = [...pages, page];
      release();
      return true;
    };
    if (!done()) {
      const stop = slice.subscribe(() => {
        if (done()) stop();
      });
    }
  }

  const who = (actor: unknown) => actorName(actor as never, app.store.agents.get());
</script>

<div class="wiki-revisions" data-testid="article-revisions">
  <div class="section-title">
    {t('Earlier revisions')}
    <span class="bar-spacer"></span>
    <button class="btn ghost small" onclick={onclose}>{t('Close')}</button>
  </div>
  {#if revisions.length === 0}
    <div class="wiki-empty-line">{t('No earlier revisions yet. They are created when the text is overwritten (after 10 minutes, by another author or by an agent).')}</div>
  {:else}
    <div class="sub-list">
      {#each revisions as r (r.id)}
        <button class={['sub-row', 'wiki-revision', selected === r.id && 'active']} data-testid="revision-row" onclick={() => (selected = selected === r.id ? null : r.id)} title={fullDate(r.at)}>
          <span class="t">{relativeTime(r.at)} · {who(r.actor)}</span>
          <span class="muted">{t('{count} characters', { count: r.chars.toLocaleString(intlLocale()) })}</span>
        </button>
        {#if selected === r.id}
          <div class="wiki-revision-preview" data-testid="revision-preview">
            {#if preview}
              <Markdown markdown={preview.markdown} />
              <div class="wiki-source-row end">
                <button class="btn small" data-testid="revision-restore" onclick={() => void app.wiki.restoreRevision(r.id)}>{t('Restore this revision')}</button>
              </div>
            {:else}
              <div class="skeleton-bar" style="width: 70%"></div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
    {#if more}<button class="btn ghost small" onclick={() => void loadMore()}>{t('Load older')}</button>{/if}
  {/if}
</div>
