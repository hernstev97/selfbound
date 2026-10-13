<script lang="ts">
  // Board: columns are the teams' statuses, cards are windowed per column. Its own chunk, loaded
  // on the first Ctrl B. Computation, focus and rules live in the core (ListController).
  import '../../styles/board.css';
  import type { IssueId } from '@xlr8/core';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import Column from './Column.svelte';
  import Empty from '../Empty.svelte';
  import { drag } from './drag.svelte.ts';
  import { landed } from '../../lib/listMotion.ts';

  const boardSlice = fromSlice(app.main.board);
  const selectionSlice = fromSlice(app.main.selectionCount);
  const board = $derived(boardSlice.current);

  /** A card in another column or position (Shift ←/→, drag, agent) lands visibly. */
  function motion(el: HTMLElement) {
    return app.main.motion.subscribe(() => {
      const m = app.main.motion.get();
      if (m?.kind === 'moved') landed(el, m.ids, '[data-testid="issue-card"]', true);
    });
  }

  /** Long press (phone) opens the context menu, as in the list. */
  function longpress(el: HTMLElement) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const start = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-testid="issue-card"]')?.dataset.id as IssueId | undefined;
      if (!id) return;
      const { clientX, clientY } = e;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        app.menu.open(id, clientX, clientY);
      }, 480);
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointermove', cancel);
    el.addEventListener('pointercancel', cancel);
    return () => {
      cancel();
      el.removeEventListener('pointerdown', start);
      el.removeEventListener('pointerup', cancel);
      el.removeEventListener('pointermove', cancel);
      el.removeEventListener('pointercancel', cancel);
    };
  }
</script>

{#if board?.empty}
  <Empty reason={board.empty} />
{:else if board}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={['board', selectionSlice.current > 0 && 'has-selection', drag.ids && 'dragging']}
    data-testid="board"
    ondragend={() => drag.end()}
    {@attach longpress}
    {@attach motion}
  >
    {#each board.columns as column (column.key)}
      <Column {column} />
    {/each}
  </div>
{/if}
