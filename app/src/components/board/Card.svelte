<script lang="ts">
  // Card: identifier with team logo, title (two lines), priority, status, labels (stack as in the
  // list, `labelStackHtml`), estimate, due date. Reads the same row state as the list (one slice per issue).
  import type { IssueId, PaletteKind } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';
  import { anchorOf, cellOf, tip } from '../../lib/ui.ts';
  import { labelStackHtml, teamLogoHtml } from '../../lib/rowHtml.ts';
  import { drag } from './drag.svelte.ts';

  let { id, top }: { id: IssueId; top: number } = $props();
  const list = app.main;
  const row = $derived(fromSlice(list.rows.get(id)));
  const r = $derived(row.current);
  const STATUS_TIP = tip(t('Change status'), 'issue.status');
  const PRIORITY_TIP = tip(t('Set priority'), 'issue.priority');
  const UNREAD_TIP = t('Still unread in the inbox');
  const SELECT_LABEL = t('Select');

  function picker(kind: PaletteKind, cell: HTMLElement) {
    const ids = list.isSelected(id) ? list.selection() : [id];
    list.focus(id);
    app.palette.open(kind, { anchor: anchorOf(cell), target: { kind: 'issues', ids } });
  }

  function click(e: MouseEvent) {
    const cell = cellOf(e);
    if (cell) {
      e.stopPropagation();
      if (cell.dataset.cell === 'check') list.toggleSelect(id);
      else picker(cell.dataset.cell as PaletteKind, cell);
      return;
    }
    list.clickRow(id, { shift: e.shiftKey, mod: e.ctrlKey || e.metaKey });
  }

  function dragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    const ids = list.isSelected(id) ? list.selection() : [id];
    e.dataTransfer.setData('application/x-xlr8-issues', JSON.stringify(ids));
    e.dataTransfer.setData('text/plain', r?.key ?? '');
    e.dataTransfer.effectAllowed = 'move';
    drag.start(ids);
  }
</script>

{#if r}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class={['card', r.focused && 'focused', r.selected && 'selected', r.pending && 'pending', drag.ids?.includes(id) && 'dragged']}
    data-testid="issue-card"
    data-id={id}
    data-key={r.key}
    data-status={r.status}
    style:top="{top}px"
    draggable="true"
    ondragstart={dragStart}
    onclick={click}
    onpointermove={(e) => {
      if (e.pointerType === 'mouse') list.hoverRow(id);
    }}
    oncontextmenu={(e) => {
      e.preventDefault();
      app.menu.open(id, e.clientX, e.clientY);
    }}
  >
    <div class="card-top">{@html teamLogoHtml(r.team, '', 14)}<span class="card-key">{r.key}</span>{#if r.unread}<span class="unseen-dot" title={UNREAD_TIP}></span>{/if}<button class={['card-check', r.selected && 'mi i-check']} aria-label={SELECT_LABEL} data-cell="check"></button></div>
    <div class="card-title" data-testid="card-title">{r.title}</div>
    <div class="card-bottom">
      <button class="cell mi p-priority p-{r.priority}" data-testid="row-priority" data-cell="priority" aria-label={r.priorityLabel} title={PRIORITY_TIP}></button>
      <button class="cell mi p-status s-{r.status}" style:color={r.statusColor} data-testid="row-status" data-cell="status" aria-label={r.statusLabel} title={STATUS_TIP}></button>
      {#if r.labels.length}{@html labelStackHtml(r.labels, 'card-labels')}{/if}
      {#if r.estimate !== null}<span class="row-est mi i-estimate">{r.estimate}</span>{/if}
      {#if r.due}<span class={['pill', 'p-due', 'mi', 'i-calendar', r.due.overdue && 'overdue']}>{r.due.label}</span>{/if}
    </div>
  </div>
{/if}
