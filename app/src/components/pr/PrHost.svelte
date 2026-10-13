<script lang="ts">
  // Issue page with a pull request beside it. Wraps the issue page (Shell.svelte); with no pull
  // request open it holds only the issue. The pull request sits on the right; its width can be
  // dragged at the divider (or ←/→ on the divider) and is remembered. On phones and in narrow
  // windows pull requests open as their own page (IssuePullRequests), so there is nothing to split.
  import '../../styles/pr.css';
  import type { Snippet } from 'svelte';
  import { t } from '@xlr8/core/i18n';
  import { app } from '../../app-instance.ts';
  import { fromSlice } from '../../slice.svelte.ts';

  let { children }: { children: Snippet } = $props();

  // The view itself loads on first open (its own chunk). Deliberately not through lib/pages.ts:
  // a lazy chunk that imports the start module splits up the start chunk.
  let view: Promise<typeof import('./PullRequestView.svelte')> | null = null;
  const loadView = () => (view ??= import('./PullRequestView.svelte'));

  const WIDTH_KEY = 'xlr8:prSplit';
  const PR_MIN = 420;
  const ISSUE_MIN = 420;
  const STEP = 24;

  const prSlice = fromSlice(app.prSplit);
  const shellSlice = fromSlice(app.shell);
  const target = $derived(shellSlice.current.mobile ? null : prSlice.current);
  // Last shown pull request: when the split closes, Svelte expressions in the block ({#key}, props)
  // run once more before {#if} removes it; they must not read null then.
  let last = { repo: '', number: 0 };
  const shown = $derived.by(() => (target ? (last = target) : last));

  let box: HTMLDivElement | undefined = $state();
  let dragging = $state(false);
  let width = $state(Number(globalThis.localStorage?.getItem(WIDTH_KEY)) || 0);

  function clamp(w: number) {
    const total = box?.clientWidth ?? w + ISSUE_MIN;
    return Math.round(Math.max(PR_MIN, Math.min(total - ISSUE_MIN, w)));
  }
  function save(w: number) {
    width = w;
    globalThis.localStorage?.setItem(WIDTH_KEY, String(w));
  }
  function current() {
    return box?.querySelector<HTMLElement>('.pr-pane')?.getBoundingClientRect().width ?? width;
  }

  function onPointerDown(e: PointerEvent & { currentTarget: HTMLElement }) {
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const right = box.getBoundingClientRect().right;
    let w = current();
    dragging = true;
    const move = (ev: PointerEvent) => {
      w = clamp(right - ev.clientX);
      box?.style.setProperty('--pr-w', `${w}px`);
    };
    const up = () => {
      dragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      save(w);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home') return;
    e.preventDefault();
    e.stopPropagation();
    save(e.key === 'Home' ? 0 : clamp(current() + (e.key === 'ArrowLeft' ? STEP : -STEP)));
  }
</script>

<div class={['pr-host', target && 'open', dragging && 'dragging']} bind:this={box} style:--pr-w={width ? `${width}px` : null} data-testid="pr-host">
  <div class={['pr-host-issue', target && 'split-detail']}>{@render children()}</div>
  {#if target}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('Pull request width')}
      aria-valuenow={width || undefined}
      tabindex="0"
      title={t('Drag to change the width, double-click to reset it')}
      data-testid="pr-split-handle"
      onpointerdown={onPointerDown}
      ondblclick={() => save(0)}
      onkeydown={onKeyDown}
    ></div>
    <section class="pr-pane" aria-label={t('Pull request')} data-testid="pr-pane">
      {#key `${shown.repo}#${shown.number}`}
        {#await loadView() then m}<m.default repo={shown.repo} number={shown.number} mode="split" />{/await}
      {/key}
    </section>
  {/if}
</div>
