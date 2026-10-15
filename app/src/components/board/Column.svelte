<script lang="ts">
  // One column: header (status, count, "+", collapse) and windowed cards. Dragging: allowed columns
  // accept, blocked ones (status missing in the team, fixed order) are dimmed.
  import { CARD_SLOT } from '@selfbound/core/board';
  import { t } from '@selfbound/core/i18n';
  import { computeWindow, statusIcon, type BoardColumn, type IssueId } from '@selfbound/core';
  import { app } from '../../app-instance.ts';
  import { issueDragPayload } from '../../lib/issueDrag.ts';
  import Card from './Card.svelte';
  import { drag } from './drag.svelte.ts';

  let { column }: { column: BoardColumn } = $props();

  // Windowing per column (fixed card height).
  let scrollTop = $state(0);
  let height = $state(0);
  const range = $derived(computeWindow(scrollTop, height, CARD_SLOT, column.ids.length));
  const start = $derived(range.start);
  const end = $derived(range.end);
  const visible = $derived(column.ids.slice(start, end));
  const problem = $derived(drag.ids ? app.main.dropProblem(drag.ids, column.key) : null);
  const over = $state({ on: false });

  // The key never changes (columns are keyed by it).
  // svelte-ignore state_referenced_locally
  const key = column.key;
  function scroller(el: HTMLDivElement) {
    app.main.registerColumnScroller(key, el);
    scrollTop = el.scrollTop;
    height = el.clientHeight;
    const observer = new ResizeObserver(() => (height = el.clientHeight));
    observer.observe(el);
    return () => {
      observer.disconnect();
      app.main.registerColumnScroller(key, null);
    };
  }

  function onDragOver(e: DragEvent) {
    if (!drag.ids || problem) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    over.on = true;
  }

  function onDrop(e: DragEvent) {
    over.on = false;
    const raw = issueDragPayload(e.dataTransfer);
    const ids = raw ? (JSON.parse(raw) as IssueId[]) : drag.ids;
    drag.end();
    if (!ids) return;
    e.preventDefault();
    app.main.dropOnColumn(ids, column.key);
  }

  function add(e: MouseEvent) {
    e.stopPropagation();
    app.create.open({ status: column.status, stateName: column.label });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  class={['board-column', column.collapsed && 'collapsed', drag.ids && (problem ? 'blocked' : 'allowed'), over.on && 'over']}
  data-testid="board-column"
  data-key={column.key}
  data-status={column.status}
  data-collapsed={column.collapsed ? 'true' : undefined}
  title={drag.ids && problem ? problem : undefined}
  style:--tint={column.color ?? undefined}
  ondragover={onDragOver}
  ondragleave={(e) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) over.on = false;
  }}
  ondrop={onDrop}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <header class="column-head" onclick={() => app.main.toggleColumn(column.key)} title={column.collapsed ? t('Expand') : t('Collapse')}>
    <span class="icon">{@html statusIcon(column.status, column.color)}</span>
    <span class="column-name" data-testid="column-name">{column.label}</span>
    <span class="group-count" data-testid="column-count">{column.ids.length}</span>
    {#if !column.collapsed}
      <span class="bar-spacer"></span>
      <button class="icon-btn plain small column-add" title={t('Create issue in this column')} aria-label={t('Create issue')} onclick={add}><span class="icon mi ui-plus"></span></button>
    {/if}
  </header>
  {#if !column.collapsed}
    <div class="column-scroll" data-testid="column-scroll" onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)} {@attach scroller}>
      <div class="column-inner" style:height="{column.ids.length * CARD_SLOT}px">
        {#each visible as id, i (id)}
          <Card {id} top={(start + i) * CARD_SLOT} />
        {/each}
      </div>
    </div>
  {/if}
</section>
