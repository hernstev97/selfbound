<script lang="ts">
  // List row, as flat as possible: team logo/identifier and title with the right-hand side are built
  // as HTML text (lib/rowHtml.ts, all user text escaped), icons are CSS masks, only visible
  // properties reach the DOM. Checkbox, priority and status are fixed elements whose class changes
  // (shown and hidden through data-props on the list).
  // The row recognizes clicks on status/priority through `data-cell`.
  // The checkbox is in every row; CSS shows it on focus/hover, selection or an existing selection in
  // the list (inserting and removing it on every J cost more than the one node).
  import type { DisplayProp, IssueId, PaletteKind } from '@xlr8/core';
  import { t } from '@xlr8/core/i18n';
  import type { ListController } from '@xlr8/core/app/list';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { anchorOf, cellOf, tip } from '../lib/ui.ts';
  import { rowLeadHtml, rowRestHtml } from '../lib/rowHtml.ts';

  interface Props {
    id: IssueId;
    top: number;
    trash?: boolean;
    list?: ListController;
    draggable?: boolean;
    /** Visible properties (display options) */
    props: ReadonlySet<DisplayProp>;
  }
  let { id, top, trash = false, list = app.main, draggable = false, props }: Props = $props();

  const row = $derived(fromSlice(list.rows.get(id)));
  // Read once instead of in every expression: one subscription effect per change.
  const r = $derived(row.current);
  const pane = $derived(list === app.side ? 'side' : 'main');
  const STATUS_TIP = tip(t('Change status'), 'issue.status');
  const PRIORITY_TIP = tip(t('Set priority'), 'issue.priority');
  const SELECT_LABEL = t('Select');
  // Derived as text: Svelte compares the string and touches the DOM only when it changes.
  const lead = $derived(r ? rowLeadHtml(r, props) : '');
  const rest = $derived(r ? rowRestHtml(r, props, trash) : '');

  function picker(kind: PaletteKind, cell: HTMLElement) {
    app.setPane(pane);
    const ids = list.isSelected(id) ? list.selection() : [id];
    list.focus(id);
    app.palette.open(kind, { anchor: anchorOf(cell), target: { kind: 'issues', ids } });
  }

  function click(e: MouseEvent) {
    const cell = cellOf(e);
    app.setPane(pane);
    if (cell) {
      e.stopPropagation();
      const kind = cell.dataset.cell;
      if (kind === 'restore') app.edit.restore([id]);
      else if (kind === 'check') list.toggleSelect(id);
      else picker(kind as PaletteKind, cell);
      return;
    }
    list.clickRow(id, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey });
  }

  function dragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    app.setPane(pane);
    const ids = list.isSelected(id) ? list.selection() : [id];
    e.dataTransfer.setData('application/x-xlr8-issues', JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', r?.key ?? '');
    e.dataTransfer.effectAllowed = 'move';
  }
</script>

{#if r}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class={['row', r.focused && 'focused', r.selected && 'selected', r.pending && 'pending']}
    data-testid="issue-row"
    data-id={id}
    data-key={r.key}
    data-status={r.status}
    data-priority={r.priority}
    data-decision={r.decision?.outcome}
    style:top="{top}px"
    draggable={draggable ? 'true' : undefined}
    ondragstart={draggable ? dragStart : undefined}
    onclick={click}
    onpointermove={(e) => {
      if (e.pointerType !== 'mouse') return;
      app.setPane(pane);
      list.hoverRow(id);
    }}
    oncontextmenu={(e) => {
      e.preventDefault();
      app.setPane(pane);
      app.menu.open(id, e.clientX, e.clientY);
    }}
  
    ><button class={['row-check', r.selected && 'mi i-check']} aria-label={SELECT_LABEL} data-testid="row-check" data-cell="check"></button><button
      class="cell mi p-priority p-{r.priority}"
      data-testid="row-priority"
      data-cell="priority"
      aria-label={r.priorityLabel}
      title={PRIORITY_TIP}
    ></button>{@html lead}<button class="cell mi p-status s-{r.status}" style:color={r.statusColor} data-testid="row-status" data-cell="status" aria-label={r.statusLabel} title={STATUS_TIP}></button>{@html rest}</div
  >
{/if}
