// List motion: groups slide open and closed, moved rows light up.
// Pure presentation on top: list, focus and scroll position are already final (ListController);
// only Web Animations on `translate` and `opacity` run here. Positions (`top`), windowing, scroll
// anchoring and dragging stay untouched. Without a signal this costs nothing.
import { tick } from 'svelte';
import type { IssueId, ListMotion } from '@selfbound/core';
import type { ListController } from '@selfbound/core/app/list';
import { DUR, EASE, STAGGER, land, reduced, stillCopy } from './motion.ts';

const ROWS = '.row, .group-row, .inbox-row';
/** Delay of the highlight after the painted result (ms) */
const LAND_DELAY = 34;

/** Rows in the DOM with their `top` (from the inline style, without reading layout). */
function rowsOf(inner: Element): { el: HTMLElement; top: number }[] {
  const out: { el: HTMLElement; top: number }[] = [];
  for (const el of inner.children) {
    if (el instanceof HTMLElement && el.matches(ROWS)) out.push({ el, top: parseFloat(el.style.top) });
  }
  return out;
}

function toggle(list: HTMLElement, m: Extract<ListMotion, { kind: 'toggle' }>, rowHeight: number) {
  const inner = list.querySelector<HTMLElement>('.list-inner');
  if (!inner) return;
  const scrollTop = list.scrollTop;
  const head = m.index * rowHeight;
  const span = m.rows * rowHeight;
  // Collapse: the group's rows are still in the DOM (Svelte redraws in a moment). An inert copy
  // stays and fades out while the rows below slide up. The copy sits next to `.list-inner` (whose
  // children belong to Svelte), in the same coordinate system.
  let ghost: HTMLElement | null = null;
  if (!m.open) {
    const layer = document.createElement('div');
    // Also `list-inner`: the column stage (variables from lib/columns.ts) then applies too.
    layer.className = 'list-inner list-ghost';
    layer.setAttribute('aria-hidden', 'true');
    layer.inert = true;
    for (const { el, top } of rowsOf(inner)) if (top > head && top <= head + span) layer.append(stillCopy(el));
    if (layer.childElementCount) {
      list.append(layer);
      ghost = layer;
    }
  }
  void tick().then(() => {
    // When the list gets shorter, the browser resets the scroll position: this offset compensates
    // the motion. If it jumps further than a screen (focus outside), there is only the fade.
    const shiftAll = list.scrollTop - scrollTop;
    const rm = reduced() || Math.abs(shiftAll) > list.clientHeight;
    const fresh: HTMLElement[] = [];
    const moving: { el: HTMLElement; from: number }[] = [];
    // At most one screen height: with large groups the rows come from just below.
    const shift = Math.min(span, list.clientHeight) * (m.open ? -1 : 1);
    for (const { el, top } of rowsOf(inner)) {
      if (m.open && top > head && top <= head + span) fresh.push(el);
      else if (top > head) moving.push({ el, from: shift + shiftAll });
      else if (shiftAll) moving.push({ el, from: shiftAll });
    }
    fresh.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    const anims: Animation[] = [];
    if (!rm) {
      // Above the rows fading out or in, and opaque (app.css `.list.sliding`), so nothing shows through.
      for (const { el, from } of moving) anims.push(el.animate([{ translate: `0 ${from}px`, zIndex: 1 }, { translate: '0 0', zIndex: 1 }], { duration: DUR[4], easing: m.open ? EASE.spring : EASE.glide }));
    }
    fresh.forEach((el, i) => {
      const delay = rm ? 0 : Math.min(i, 8) * STAGGER;
      anims.push(el.animate([{ opacity: 0, translate: rm ? '0 0' : '0 -4px' }, {}], { duration: rm ? DUR[1] : DUR[3], delay, easing: EASE.out, fill: 'backwards' }));
    });
    if (ghost) {
      const g = ghost;
      // The copy stays where the rows were just visible.
      if (shiftAll && !rm) g.style.translate = `0 ${shiftAll}px`;
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: rm ? DUR[1] : DUR[3], easing: EASE.in, fill: 'forwards' }).finished.then(
        () => g.remove(),
        () => g.remove(),
      );
    }
    if (!anims.length) return;
    list.classList.add('sliding');
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => list.classList.remove('sliding'));
  });
}

/**
 * Rows or cards that moved after a change light up briefly, about two frames after the frame with
 * the new position. Previously (second rAF chain, task right after) the start was attached to the
 * response itself: moving a card cost 7–9 ms more in benchmarks.
 */
export function landed(root: HTMLElement, ids: readonly IssueId[], selector: string, pop = false) {
  requestAnimationFrame(() =>
    setTimeout(() => {
      for (const id of ids) {
        const el = root.querySelector<HTMLElement>(`${selector}[data-id="${CSS.escape(id)}"]`);
        if (el?.isConnected) land(el, { pop });
      }
    }, LAND_DELAY),
  );
}

/** Attachment for `.list`: listens to the controller's motion signal. */
export function listMotion(controller: ListController, rowHeight: () => number) {
  return (list: HTMLElement) =>
    controller.motion.subscribe(() => {
      const m = controller.motion.get();
      if (!m) return;
      if (m.kind === 'toggle') toggle(list, m, rowHeight());
      else landed(list, m.ids, '[data-testid="issue-row"]');
    });
}
