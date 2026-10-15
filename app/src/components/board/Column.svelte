<script lang="ts">
  // One column: header (status, count, "+", collapse) and windowed cards. Dragging: allowed columns
  // accept, blocked ones (status missing in the team, fixed order) are dimmed.
  // Cards grow with their title: heights are measured once a card is drawn (ResizeObserver) and
  // estimated until then; cards above the viewport that change keep the scroll position steady.
  import { onDestroy, tick } from 'svelte';
  import { CARD_ESTIMATE, CARD_GAP } from '@selfbound/core/board';
  import { t } from '@selfbound/core/i18n';
  import { buildOffsets, computeVariableWindow, indexAt, statusIcon, type BoardColumn, type IssueId } from '@selfbound/core';
  import { app } from '../../app-instance.ts';
  import { issueDragPayload } from '../../lib/issueDrag.ts';
  import Card from './Card.svelte';
  import { drag } from './drag.svelte.ts';

  let { column }: { column: BoardColumn } = $props();

  // Windowing per column. `measured` is a plain cache; `version` tells the offsets to rebuild.
  let scrollTop = $state(0);
  let height = $state(0);
  let version = $state(0);
  const measured = new Map<IssueId, number>();
  const offsets = $derived.by(() => {
    void version;
    if (measured.size > column.ids.length + 100) {
      const live = new Set<string>(column.ids);
      for (const id of measured.keys()) if (!live.has(id)) measured.delete(id);
    }
    return buildOffsets(column.ids, measured, CARD_ESTIMATE, CARD_GAP);
  });
  const range = $derived(computeVariableWindow(offsets, scrollTop, height));
  const start = $derived(range.start);
  const end = $derived(range.end);
  const visible = $derived(column.ids.slice(start, end));
  const problem = $derived(drag.ids ? app.main.dropProblem(drag.ids, column.key) : null);
  const over = $state({ on: false });

  // The key never changes (columns are keyed by it).
  // svelte-ignore state_referenced_locally
  const key = column.key;
  function scroller(el: HTMLDivElement) {
    app.main.registerColumnScroller(key, {
      el,
      span(index) {
        const id = column.ids[index];
        const h = measured.get(id);
        const top = offsets[index] ?? 0;
        return { top, bottom: top + (h ?? CARD_ESTIMATE), measured: h !== undefined };
      },
    });
    scrollTop = el.scrollTop;
    height = el.clientHeight;
    let width = el.clientWidth;
    // A new column width wraps titles differently: read the cards that are drawn again, forget the rest.
    const resize = new ResizeObserver(() => {
      height = el.clientHeight;
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Keep the first visible card where it is: everything above it goes back to estimates.
      const first = indexAt(offsets, el.scrollTop);
      const inset = el.scrollTop - (offsets[first] ?? 0);
      measured.clear();
      for (const card of el.querySelectorAll<HTMLElement>('.card')) measured.set(card.dataset.id as IssueId, card.offsetHeight);
      version++;
      void tick().then(() => (el.scrollTop = (offsets[first] ?? 0) + inset));
    });
    resize.observe(el);
    scrollEl = el;
    return () => {
      resize.disconnect();
      scrollEl = null;
      app.main.registerColumnScroller(key, null);
    };
  }

  // Created with the component (not in `scroller`): the cards attach before their column's scroller does.
  let scrollEl: HTMLElement | null = null;
  let shift = 0;
  const cards = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const card = entry.target as HTMLElement;
      const id = card.dataset.id as IssueId;
      const h = entry.borderBoxSize?.[0]?.blockSize ?? card.offsetHeight;
      const old = measured.get(id);
      if (old !== undefined && Math.abs(old - h) < 0.5) continue;
      // A card entirely above the viewport pushes everything below it: take the difference off the scroll position.
      if (scrollEl && parseFloat(card.style.top) + (old ?? CARD_ESTIMATE) <= scrollEl.scrollTop) shift += h - (old ?? CARD_ESTIMATE);
      measured.set(id, h);
      changed = true;
    }
    if (!changed) return;
    version++;
    if (shift)
      void tick().then(() => {
        if (scrollEl) scrollEl.scrollTop += shift;
        shift = 0;
      });
  });
  onDestroy(() => cards.disconnect());
  function observeCard(card: HTMLElement) {
    cards.observe(card);
    return () => cards.unobserve(card);
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
    app.create.open(column.priority !== undefined ? { priority: column.priority } : { status: column.status, stateName: column.label });
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  class={['board-column', column.collapsed && 'collapsed', drag.ids && (problem ? 'blocked' : 'allowed'), over.on && 'over']}
  data-testid="board-column"
  data-key={column.key}
  data-status={column.priority === undefined ? column.status : undefined}
  data-priority={column.priority}
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
    {#if column.priority !== undefined}
      <span class="icon mi p-priority p-{column.priority}"></span>
    {:else}
      <span class="icon">{@html statusIcon(column.status, column.color)}</span>
    {/if}
    <span class="column-name" data-testid="column-name">{column.label}</span>
    <span class="group-count" data-testid="column-count">{column.ids.length}</span>
    {#if !column.collapsed}
      <span class="bar-spacer"></span>
      <button class="icon-btn plain small column-add" title={t('Create issue in this column')} aria-label={t('Create issue')} onclick={add}><span class="icon mi ui-plus"></span></button>
    {/if}
  </header>
  {#if !column.collapsed}
    <div class="column-scroll" data-testid="column-scroll" onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)} {@attach scroller}>
      <div class="column-inner" style:height="{offsets[column.ids.length]}px">
        {#each visible as id, i (id)}
          <Card {id} top={offsets[start + i]} observe={observeCard} />
        {/each}
      </div>
    </div>
  {/if}
</section>
