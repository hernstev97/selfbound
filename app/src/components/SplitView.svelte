<script lang="ts">
  // Split view: the list (or board) on the left, the regular issue detail of the focused entry on
  // the right. The wide inbox is always split; other lists while the split view is open (⇧ space).
  // Click, J/K and space show the issue on the right; the list stays put. Always rendered around the
  // list, also when not split: opening and closing only adds the right side, the list is not rebuilt.
  // The list width can be dragged at the divider (or ←/→ on the divider) and is remembered, for the
  // inbox and the other lists separately.
  import type { Snippet } from 'svelte';
  import { ICON, INBOX_SPLIT_DEFAULT, LIST_SPLIT_DEFAULT, formatShortcut, shortcutOf } from '@selfbound/core';
  import { t } from '@selfbound/core/i18n';
  import { app } from '../app-instance.ts';
  import { fromSlice } from '../slice.svelte.ts';
  import { pages } from '../lib/pages.ts';
  import Lazy from './Lazy.svelte';

  let { active, inbox, children }: { active: boolean; inbox: boolean; children: Snippet } = $props();

  /** Minimum width of the list and of the issue on the right (px) */
  const LIST_MIN = 320;
  const DETAIL_MIN = 480;
  const STEP = 24;

  const splitSlice = fromSlice(app.detail.split);
  const detailSlice = fromSlice(app.detail.state);
  const prefsSlice = fromSlice(app.prefs.state);
  const headerSlice = fromSlice(app.main.header);
  const shellSlice = fromSlice(app.shell);
  // On the issue's own page (Enter) only that page shows the detail, not the hidden list as well.
  const shown = $derived(splitSlice.current && shellSlice.current.page === 'view' && detailSlice.current !== null);
  const fallback = $derived(inbox ? INBOX_SPLIT_DEFAULT : LIST_SPLIT_DEFAULT);
  const saved = $derived(inbox ? prefsSlice.current.inboxSplit : prefsSlice.current.listSplit);

  let box: HTMLDivElement | undefined = $state();
  /** While dragging: width set directly on the element, saved only on release */
  let dragging = $state(false);

  function clamp(width: number) {
    const total = box?.clientWidth ?? width + DETAIL_MIN;
    return Math.round(Math.max(LIST_MIN, Math.min(total - DETAIL_MIN, width)));
  }

  function setWidth(width: number) {
    box?.style.setProperty('--split-w', `${width}px`);
  }

  function save(width: number) {
    if (width !== saved) app.prefs.set(inbox ? { inboxSplit: width } : { listSplit: width });
  }

  function current() {
    return box?.querySelector<HTMLElement>('.split-list')?.getBoundingClientRect().width ?? saved;
  }

  function onPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const left = box.getBoundingClientRect().left;
    let width = current();
    dragging = true;
    const move = (ev: PointerEvent) => {
      width = clamp(ev.clientX - left);
      setWidth(width);
    };
    const up = () => {
      dragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      save(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
    e.preventDefault();
    e.stopPropagation();
    const width = e.key === 'Home' ? clamp(fallback) : clamp(current() + (e.key === 'ArrowLeft' ? -STEP : STEP));
    setWidth(width);
    save(width);
  }

  function reset() {
    const width = clamp(fallback);
    setWidth(width);
    save(width);
  }

  const key = (id: string) => {
    const k = shortcutOf(id);
    return k ? formatShortcut(k) : '';
  };
</script>

<div
  class={['split', active && 'on', dragging && 'dragging']}
  data-testid={active ? (inbox ? 'inbox-split' : 'list-split') : undefined}
  bind:this={box}
  style:--split-w={active ? `${saved}px` : undefined}
>
  <div class="split-list">{@render children()}</div>
  {#if active}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('List width')}
      aria-valuenow={saved}
      tabindex="0"
      title={t('Drag to change the width, double-click to reset it')}
      data-testid="split-handle"
      onpointerdown={onPointerDown}
      ondblclick={reset}
      onkeydown={onKeyDown}
    ></div>
    <section class="split-detail" data-testid="split-detail" aria-label="Issue">
      {#if shown}
        <Lazy load={pages.issue} props={{ split: true }} />
      {:else}
        <div class="split-empty" data-testid="split-empty">
          <div class="empty-icon"><span class="icon">{@html inbox ? ICON.inbox : ICON.issues}</span></div>
          {#if headerSlice.current.count === 0}
            <div>{inbox ? t('All done. New entries appear on the left.') : t('No issues in this view.')}</div>
          {:else if inbox}
            <div>{t('Pick an entry on the left to see the issue here.')}</div>
            <div class="split-keys">
              <span><kbd>J</kbd> <kbd>K</kbd> {t('switch')}</span>
              <span><kbd>{key('inbox.remove')}</kbd> {t('remove')}</span>
              <span><kbd>U</kbd> {t('read')}</span>
            </div>
          {:else}
            <div>{t('Pick an issue on the left to see it here.')}</div>
            <div class="split-keys">
              <span><kbd>J</kbd> <kbd>K</kbd> {t('switch')}</span>
              <span><kbd>{key('view.split')}</kbd> {t('close')}</span>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>
