<script lang="ts" module>
  import type { ListController as LC } from '@selfbound/core/app/list';
  const lastWidth = new WeakMap<LC, number>();
</script>

<script lang="ts">
  import { INBOX_ROW_HEIGHT, ROW_HEIGHT, ROW_HEIGHT_MOBILE, computeWindow, type IssueId } from '@selfbound/core';
  import type { ListController } from '@selfbound/core/app/list';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { clearKeyWidths, keyColumnWidth } from '../lib/ui.ts';
  import { columnPlan, groupColsHtml, stageOf } from '../lib/columns.ts';
  import { listMotion } from '../lib/listMotion.ts';
  import IssueRow from './IssueRow.svelte';
  import GroupRow from './GroupRow.svelte';
  import InboxRow from './InboxRow.svelte';
  import Empty from './Empty.svelte';

  interface Props {
    scrollChange?: (scrolled: boolean) => void;
    /** Which list (sprint planning: second column) */
    list?: ListController;
    /** Drag and drop (sprint planning): the target reports issues and insert position */
    drop?: (ids: IssueId[], index: number) => void;
    testid?: string;
  }
  let { scrollChange, list: controller = app.main, drop, testid = 'list' }: Props = $props();

  const SKELETON = [62, 48, 70, 55, 66, 40, 58];
  // svelte-ignore state_referenced_locally
  const listSlice = fromSlice(controller.list);
  // svelte-ignore state_referenced_locally
  const viewSlice = fromSlice(controller.view);
  // svelte-ignore state_referenced_locally
  const selectionSlice = fromSlice(controller.selectionCount);
  const mobileSlice = fromSlice(app.mobile);
  const syncSlice = fromSlice(app.store.sync);
  const prefsSlice = fromSlice(app.prefs.state);
  const list = $derived(listSlice.current);
  const rowHeight = $derived(list.style === 'inbox' ? INBOX_ROW_HEIGHT : mobileSlice.current ? ROW_HEIGHT_MOBILE : ROW_HEIGHT);
  // Identifier column as wide as the widest visible identifier (measured, never cut off).
  let fontEpoch = $state(0);
  const idWidth = $derived(keyColumnWidth(list.keySamples, `${prefsSlice.current.fontSize}:${fontEpoch}`));
  // Phone: only priority, status and due date (space); everything else never reaches the DOM.
  const MOBILE_PROPS = new Set(['priority', 'status', 'due']);
  const shownProps = $derived(new Set(viewSlice.current.display.props.filter((p) => !mobileSlice.current || MOBILE_PROPS.has(p))));
  // Column stages: width from the ResizeObserver, stage as an attribute on the list.
  // Last measured width of this list: the first render already has the right stage
  // (otherwise the browser computes style and layout of all rows twice on mount).
  // svelte-ignore state_referenced_locally
  let width = $state(lastWidth.get(controller) ?? 0);
  // Glide only after the first measurement (otherwise the list glides from narrow to wide on load).
  let glide = $state(false);
  const plan = $derived(columnPlan(shownProps, idWidth));
  const stage = $derived(stageOf(width, plan));
  // Column icons for all group headers, once per display
  const headCols = $derived(groupColsHtml(shownProps));
  const loading = $derived(list.count === 0 && (syncSlice.current.phase === 'empty' || syncSlice.current.phase === 'syncing'));

  // The only local state: windowing (fixed row height).
  let scrollTop = $state(0);
  let height = $state(0);
  const range = $derived(computeWindow(scrollTop, height, rowHeight, list.rows.length));
  // Derived as numbers: scrolling within a row does not change them, so `visible` stays put.
  const start = $derived(range.start);
  const end = $derived(range.end);
  type GroupListRow = Extract<(typeof list.rows)[number], { kind: 'group' }>;
  const split = $derived.by(() => {
    const groups: { row: GroupListRow; top: number }[] = [];
    const issues: { id: IssueId; top: number }[] = [];
    for (let i = start; i < end; i++) {
      const row = list.rows[i];
      if (row.kind === 'group') groups.push({ row, top: i * rowHeight });
      else issues.push({ id: row.id, top: i * rowHeight });
    }
    return { groups, issues };
  });
  const groups = $derived(split.groups);
  const issues = $derived(split.issues);
  /** Insert position while dragging (row index), null = nothing dragged */
  let dropAt = $state<number | null>(null);

  // Long press (phone) opens the context menu: one listener for the whole list instead of four per row.
  function longpress(el: HTMLElement) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const start = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-testid="issue-row"]')?.dataset.id as IssueId | undefined;
      if (!id) return;
      fired = false;
      const { clientX, clientY } = e;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        // If no click follows (finger moved away), the block does not last forever.
        setTimeout(() => (fired = false), 1000);
        app.menu.open(id, clientX, clientY);
      }, 480);
    };
    // After the long press, releasing still fires a click. It often lands on the opened menu
    // (the entry under the finger) and must neither open the issue nor trigger a menu entry:
    // swallow it once at window level.
    let fired = false;
    const swallow = (e: MouseEvent) => {
      if (!fired) return;
      fired = false;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointermove', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('scroll', cancel, { passive: true });
    // A team logo in a row fails to load: placeholder with the key (like TeamLogo.svelte).
    const broken = (e: Event) => {
      const img = e.target as HTMLElement;
      const logo = img.tagName === 'IMG' ? img.parentElement : null;
      if (!logo?.dataset.letter) return;
      logo.classList.remove('img');
      logo.removeAttribute('data-logo');
      logo.textContent = logo.dataset.letter;
    };
    el.addEventListener('error', broken, true);
    return () => {
      el.removeEventListener('error', broken, true);
      window.removeEventListener('click', swallow, true);
      cancel();
      el.removeEventListener('pointerdown', start);
      el.removeEventListener('pointerup', cancel);
      el.removeEventListener('pointermove', cancel);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('scroll', cancel);
    };
  }

  // Checkbox Shift+click and click+drag: one set of listeners for the whole list (no per-row cost).
  // The first press toggles the row (its state decides select or deselect for the drag), moving over
  // other rows selects the range from there. Touch has no checkbox (hidden on phones): not covered.
  function rangeSelect(el: HTMLElement) {
    // Above or below the list the pointer counts as on the first or last visible row.
    const rowAt = (x: number, y: number) => {
      const box = el.getBoundingClientRect();
      const at = document.elementFromPoint(x, Math.max(box.top + 1, Math.min(box.bottom - 1, y)));
      return at?.closest<HTMLElement>('[data-testid="issue-row"]')?.dataset.id as IssueId | undefined;
    };
    let dragging = false;
    let swallowClick = false;
    let last: IssueId | undefined;
    let pointer = { x: 0, y: 0 };
    let frame = 0;
    const over = () => {
      const id = rowAt(pointer.x, pointer.y);
      if (id && id !== last) {
        last = id;
        controller.selectRange(id);
      }
    };
    // Near the top or bottom edge the list scrolls on its own while the button is held.
    const tick = () => {
      if (!dragging) return;
      const box = el.getBoundingClientRect();
      const edge = 48;
      const speed = pointer.y < box.top + edge ? pointer.y - box.top - edge : pointer.y > box.bottom - edge ? pointer.y - box.bottom + edge : 0;
      if (speed) {
        el.scrollTop += Math.max(-24, Math.min(24, speed / 2));
        over();
      }
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      // The click after pointerup still arrives; later it must work normally again (keyboard activation).
      setTimeout(() => (swallowClick = false), 0);
    };
    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      over();
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement;
      swallowClick = false;
      if (target.dataset.cell !== 'check') return;
      const id = target.closest<HTMLElement>('[data-testid="issue-row"]')?.dataset.id as IssueId | undefined;
      if (!id) return;
      app.setPane(controller === app.side ? 'side' : 'main');
      // No text selection and no native row drag (sprint planning) from the checkbox.
      e.preventDefault();
      if (e.shiftKey) controller.selectRange(id);
      else controller.toggleSelect(id);
      swallowClick = true;
      dragging = true;
      last = id;
      pointer = { x: e.clientX, y: e.clientY };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
      frame = requestAnimationFrame(tick);
    };
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      e.stopPropagation();
      e.preventDefault();
    };
    // Sprint planning rows are draggable: no native drag from the checkbox.
    const nativeDrag = (e: DragEvent) => {
      if (dragging) e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('dragstart', nativeDrag);
    el.addEventListener('click', click, true);
    return () => {
      stop();
      el.removeEventListener('dragstart', nativeDrag);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('click', click, true);
    };
  }

  function scroller(el: HTMLDivElement) {
    controller.registerScroller(el);
    scrollTop = el.scrollTop;
    height = el.clientHeight;
    width = el.clientWidth;
    lastWidth.set(controller, width);
    requestAnimationFrame(() => requestAnimationFrame(() => (glide = true)));
    const observer = new ResizeObserver(() => {
      height = el.clientHeight;
      width = el.clientWidth;
      lastWidth.set(controller, width);
    });
    observer.observe(el);
    // Web font loaded: measure identifiers again.
    document.fonts?.ready.then(() => {
      clearKeyWidths();
      fontEpoch++;
    });
    return () => {
      observer.disconnect();
      glide = false;
      controller.registerScroller(null);
    };
  }

  function handleScroll(e: Event & { currentTarget: HTMLDivElement }) {
    scrollTop = e.currentTarget.scrollTop;
    controller.saveScroll(scrollTop);
    scrollChange?.(scrollTop > 0);
  }

  function indexAt(e: DragEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    const y = e.clientY - r.top + el.scrollTop;
    return Math.max(0, Math.min(list.rows.length, Math.round(y / rowHeight)));
  }

  function onDragOver(e: DragEvent & { currentTarget: HTMLElement }) {
    if (!drop || !e.dataTransfer?.types.includes('application/x-xlr8-issues')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropAt = indexAt(e, e.currentTarget);
  }

  function onDrop(e: DragEvent & { currentTarget: HTMLElement }) {
    if (!drop) return;
    const raw = e.dataTransfer?.getData('application/x-xlr8-issues');
    dropAt = null;
    if (!raw) return;
    e.preventDefault();
    // Row index → position among the issues (group headers do not count).
    const rowIndex = indexAt(e, e.currentTarget);
    let issueIndex = 0;
    for (let i = 0; i < rowIndex && i < list.rows.length; i++) if (list.rows[i].kind === 'issue') issueIndex++;
    drop(JSON.parse(raw) as IssueId[], issueIndex);
  }
</script>

{#if loading}
  {#if syncSlice.current.offline}
    <!-- Start without network and without cache: say why nothing appears. -->
    <p class="offline-note" role="status" data-testid="list-offline">{t('Offline. This device has no saved copy of this list yet; it appears once the network is back.')}</p>
  {/if}
  <div class="skeleton" data-testid="list-loading">
    {#each SKELETON as w, i (i)}
      <div class="skeleton-row"><div class="skeleton-bar" style="width: 16px"></div><div class="skeleton-bar" style="width: 56px"></div><div class="skeleton-bar" style:width="{w}%"></div></div>
    {/each}
  </div>
{:else if list.empty && !drop}
  <Empty reason={list.empty} list={controller} />
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class={['list', selectionSlice.current > 0 && 'has-selection', drop && 'dnd', glide && 'glide']}
    data-testid={testid}
    data-props={[...shownProps].join(' ')}
    style:--row-h="{rowHeight}px"
    style:--id-w="{idWidth}px"
    data-stage={stage}
    onscroll={handleScroll}
    ondragover={onDragOver}
    ondragleave={(e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropAt = null;
    }}
    ondrop={onDrop}
    {@attach scroller}
    {@attach longpress}
    {@attach rangeSelect}
    {@attach listMotion(controller, () => rowHeight)}
  >
    {#if list.empty}
      <Empty reason={list.empty} list={controller} />
    {/if}
    <div class="list-inner" style:height="{list.rows.length * rowHeight + 8}px">
      <!-- Group headers and rows separately: no {#if} (comment node) per row. -->
      {#each groups as g (g.row.key)}<GroupRow row={g.row} top={g.top} list={controller} cols={headCols} />{/each}
      {#if list.style === 'inbox'}
        {#each issues as it (it.id)}<InboxRow id={it.id} top={it.top} />{/each}
      {:else}
        {#each issues as it (it.id)}<IssueRow id={it.id} top={it.top} trash={list.style === 'trash'} list={controller} draggable={!!drop} props={shownProps} />{/each}
      {/if}
      {#if dropAt !== null}
        <div class="drop-line" data-testid="drop-line" style:transform="translateY({dropAt * rowHeight}px)"></div>
      {/if}
    </div>
  </div>
{/if}
