<script lang="ts">
  // "Mentioned in" on a knowledge page: issues and pages that link to it, plus the issues the page
  // itself mentions. Own subscription while the page is open.
  import { api } from '@selfbound/backend/api';
  import { t } from '@selfbound/core/i18n';
  import type { FunctionReturnType } from 'convex/server';
  import { ICON, statusIcon } from '@selfbound/core';
  import { app } from '../../app-instance.ts';

  type Links = FunctionReturnType<typeof api.wiki.backlinks>;
  let { articleId }: { articleId: string } = $props();
  let links = $state<Links | null>(null);

  $effect(() => {
    const { slice, release } = app.store.watch(api.wiki.backlinks, { articleId: articleId as never });
    const update = () => (links = slice.get() ?? null);
    update();
    const stop = slice.subscribe(update);
    return () => {
      stop();
      release();
    };
  });

  function go(e: MouseEvent, run: () => void) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    run();
  }
  const color = (stateId: string | undefined) => app.store.meta.get()?.workflowStates.find((s) => s._id === stateId)?.color ?? null;
</script>

{#snippet issueRow(i: Links['issues'][number])}
  <a class="sub-row" href="/issue/{i.identifier}" onclick={(e) => go(e, () => app.nav.go({ name: 'issue', key: i.identifier }))}>
    <span class="icon">{@html statusIcon(i.status, color(i.stateId))}</span>
    <span class="key">{i.identifier}</span>
    <span class="t">{i.title}</span>
  </a>
{/snippet}

{#if links && (links.issues.length || links.pages.length)}
  <div class="section-title">{t('Mentioned in')}</div>
  <div class="sub-list" data-testid="article-mentioned-in">
    {#each links.pages as p (p.id)}
      <a class="sub-row" href="/wiki/{p.id}" onclick={(e) => go(e, () => app.wiki.open(p.id))}>
        <span class="icon">{@html ICON.page}</span><span class="t">{p.title}</span>
      </a>
    {/each}
    {#each links.issues as i (i.id)}{@render issueRow(i)}{/each}
  </div>
{/if}
{#if links?.mentions.length}
  <div class="section-title">{t('Mentioned issues')}</div>
  <div class="sub-list" data-testid="article-mentions">
    {#each links.mentions as i (i.id)}{@render issueRow(i)}{/each}
  </div>
{/if}
