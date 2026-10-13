<script lang="ts">
  // Page tree of a team: click opens, the caret expands/collapses, dragging reorders and nests
  // (top or bottom quarter of a row: before or after, middle: as a subpage).
  import { ICON, type WikiState } from '@xlr8/core';
  import { t, tc } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';

  let { state: s }: { state: WikiState } = $props();

  let dragging = $state<string | null>(null);
  let over = $state<{ id: string; place: 'before' | 'after' | 'inside' } | null>(null);

  function placeOf(e: DragEvent): 'before' | 'after' | 'inside' {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
  }

  function open(e: MouseEvent, id: string) {
    if (e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    app.wiki.open(id);
  }
</script>

{#if s.topics.length || s.projects.length}
  <div class="wiki-filter" data-testid="wiki-filter">
    {#if s.projects.length}
      <select aria-label={t('Filter by project')} data-testid="wiki-filter-project" value={s.filter.projectId ?? ''} onchange={(e) => app.wiki.setFilter({ projectId: (e.currentTarget as HTMLSelectElement).value || null })}>
        <option value="">{t('All projects')}</option>
        {#each s.projects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
      </select>
    {/if}
    {#if s.topics.length}
      <select aria-label={t('Filter by topic')} data-testid="wiki-filter-topic" value={s.filter.topicId ?? ''} onchange={(e) => app.wiki.setFilter({ topicId: (e.currentTarget as HTMLSelectElement).value || null })}>
        <option value="">{t('All topics')}</option>
        {#each s.topics.filter((x) => !x.archived) as topic (topic.id)}<option value={topic.id}>{topic.name}</option>{/each}
      </select>
    {/if}
  </div>
{/if}
<div class="wiki-tree" role="tree" aria-label={t('Pages')} data-testid="wiki-tree">
  {#if s.rows === null}
    <div class="skeleton-bar" style="width: 70%; margin: 10px 12px"></div>
    <div class="skeleton-bar" style="width: 55%; margin: 10px 12px"></div>
  {:else if s.rows.length === 0}
    <div class="wiki-tree-empty">{s.filter.projectId || s.filter.topicId ? t('No page matches the filter.') : t('No pages yet.')}</div>
  {:else}
    {#each s.rows as row (row.id)}
      <a
        class={['wiki-row', row.id === s.articleId && 'active', dragging === row.id && 'dragging', over?.id === row.id && `drop-${over.place}`]}
        href="/wiki/{row.id}"
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={row.hasChildren ? row.expanded : undefined}
        aria-selected={row.id === s.articleId}
        style:--depth={row.depth}
        draggable="true"
        data-testid="wiki-row"
        data-id={row.id}
        onclick={(e) => open(e, row.id)}
        onkeydown={(e) => {
          // Keyboard as in a tree: → expands, ← collapses (or moves to the parent page).
          if (e.key === 'ArrowRight' && row.hasChildren && !row.expanded) {
            e.preventDefault();
            app.wiki.toggle(row.id);
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (row.hasChildren && row.expanded) app.wiki.toggle(row.id);
            else if (row.parentId) document.querySelector<HTMLElement>(`[data-testid="wiki-row"][data-id="${row.parentId}"]`)?.focus();
          }
        }}
        onpointerenter={() => app.wiki.prefetch(row.id)}
        ondragstart={(e) => {
          dragging = row.id;
          e.dataTransfer?.setData('text/plain', row.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        }}
        ondragend={() => {
          dragging = null;
          over = null;
        }}
        ondragover={(e) => {
          if (!dragging || dragging === row.id) return;
          e.preventDefault();
          over = { id: row.id, place: placeOf(e) };
        }}
        ondragleave={() => {
          if (over?.id === row.id) over = null;
        }}
        ondrop={(e) => {
          e.preventDefault();
          const id = dragging;
          const place = placeOf(e);
          dragging = null;
          over = null;
          if (id && id !== row.id) void app.wiki.drop(id, row.id, place);
        }}
      >
        {#if row.hasChildren}
          <button
            class="wiki-caret"
            aria-label={row.expanded ? tc('tree', 'Collapse') : t('Expand')}
            data-testid="wiki-toggle"
            onclick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              app.wiki.toggle(row.id);
            }}><span class={['icon mi ui-caretRight', row.expanded && 'open']}></span></button
          >
        {:else}
          <span class="wiki-caret-space"><span class="icon mi ui-page"></span></span>
        {/if}
        <span class="wiki-row-title">{row.title}</span>
        <button
          class="wiki-row-add"
          title={t('Create subpage')}
          aria-label={t('Create subpage')}
          data-testid="wiki-add-child"
          onclick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void app.wiki.create(row.id);
          }}><span class="icon">{@html ICON.plus}</span></button
        >
      </a>
    {/each}
  {/if}
</div>
