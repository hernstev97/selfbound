<script lang="ts">
  // "Knowledge" section on an issue: pages the issue links to or that mention it.
  // Its own query, only while the detail is shown (not when preloading with J/K), and only
  // when a team has a knowledge area.
  import { api } from '@xlr8/backend/api';
  import type { FunctionReturnType } from 'convex/server';
  import { ICON, pagePath } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';

  let { issueId }: { issueId: string } = $props();
  const metaSlice = fromSlice(app.store.meta);
  const enabled = $derived(metaSlice.current?.teams.some((team) => team.wiki) ?? false);
  let pages = $state<FunctionReturnType<typeof api.wiki.forIssue>>([]);

  $effect(() => {
    if (!enabled || issueId.startsWith('tmp:')) {
      pages = [];
      return;
    }
    // Only after the frame in which the issue opens: opening (Enter) does not pay for the subscription.
    let stop = () => {};
    let release = () => {};
    let frame = requestAnimationFrame(() => {
      frame = 0;
      const watch = app.store.watch(api.wiki.forIssue, { issueId: issueId as never });
      release = watch.release;
      const update = () => (pages = watch.slice.get() ?? []);
      update();
      stop = watch.slice.subscribe(update);
    });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      stop();
      release();
    };
  });

  const teamKey = (teamId: string) => metaSlice.current?.teams.find((team) => team._id === teamId)?.key ?? '';
</script>

{#if pages.length}
  <div class="section-title">{t('Knowledge')}</div>
  <div class="sub-list" data-testid="issue-knowledge">
    {#each pages as p (p.id)}
      <a
        class="sub-row"
        href={pagePath({ name: 'article', id: p.id })}
        onclick={(e) => {
          if (e.metaKey || e.ctrlKey || e.button !== 0) return;
          e.preventDefault();
          app.nav.go({ name: 'article', id: p.id });
        }}
      >
        <span class="icon">{@html ICON.page}</span>
        <span class="key">{teamKey(p.teamId)}</span>
        <span class="t">{p.title}</span>
        <span class="pill">{p.via === 'linked' ? t('linked') : t('mentions this issue')}</span>
      </a>
    {/each}
  </div>
{/if}
