// Sidebar motion: team switches and sections opening/closing as FLIP.
// State, content on the right and focus switch immediately; only Web Animations on `translate` and
// `opacity` run here. Every element with `data-flip="<key>"` is measured before the change
// (`before`, from `$effect.pre`) and afterwards, in the next frame before paint, moved back to its
// old place (`after`):
//   - same key, different place: slides there (cards, section headers, items)
//   - new key: fades in staggered (the chosen team expands, a section opens)
//   - key gone: an inert copy stays briefly and fades out (the old team collapses)
// Put keys on leaves only, never on a wrapper around others: otherwise content would move twice.
// Team cards change size in the process (small row → large card docked to the panel). Their parts
// with `data-part` (surface, logo, name, counts, corners at the panel) move individually inside the
// card: the surface grows via `scale`, the logo scales, the text slides. What exists on only one
// side (counts, corners) fades in, or fades out as a copy.
import { Slice, type SidebarState } from '@selfbound/core';
import { DUR, EASE, STAGGER, reduced, stillCopy } from './motion.ts';

interface Item {
  el: HTMLElement;
  rect: DOMRect;
  /** Parts of a team card (`data-part`), as seen */
  parts?: Map<string, { el: HTMLElement; rect: DOMRect }>;
}

interface Snapshot {
  items: Map<string, Item>;
  current: string | null;
}

function partsOf(el: HTMLElement) {
  const parts = new Map<string, { el: HTMLElement; rect: DOMRect }>();
  for (const part of el.querySelectorAll<HTMLElement>('[data-part]')) parts.set(part.dataset.part!, { el: part, rect: part.getBoundingClientRect() });
  return parts;
}

const moved = (a: number, b: number) => Math.abs(a - b) >= 0.5;

export class SidebarMotion {
  #snap: Snapshot | null = null;
  #anims: Animation[] = [];
  #ghosts: HTMLElement[] = [];
  #frame = 0;

  /**
   * Before the change (Svelte `$effect.pre`): positions of all keys. Runs only when the sidebar's
   * structure changes (other team, section open/closed), not on every page change. Running motion
   * counts: a second switch in the middle of the first starts from the position that was seen.
   */
  before(root: HTMLElement | null | undefined, current: string | null) {
    // Second change before the first was painted: what was visible is still the layout before the first.
    if (this.#frame) return;
    this.#snap = null;
    if (!root?.isConnected || root.offsetParent === null) return;
    const items = new Map<string, Item>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) items.set(el.dataset.flip!, { el, rect: el.getBoundingClientRect(), parts: el.querySelector('[data-part]') ? partsOf(el) : undefined });
    // Empty: the teams are just arriving (startup). Fade nothing in; the first frames belong to the list.
    if (items.size) this.#snap = { items, current };
  }

  /**
   * After the change: in the next frame, before paint, move everything to its old place and let it
   * slide. Only then, because by that time the content on the right is new too, so the browser
   * computes layout once. Reading right after the Svelte update made team switches cost 3 ms more.
   */
  after(root: HTMLElement | null | undefined, current: string | null, opts: { animate: boolean }) {
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      const snap = this.#snap;
      this.#snap = null;
      this.#stop();
      if (snap && root?.isConnected && opts.animate) this.#play(root, current, snap);
    });
  }

  #play(root: HTMLElement, current: string | null, snap: Snapshot) {
    const switched = snap.current !== current;
    // The chosen team is at the top: scroll there; the card then slides up from its old position.
    if (switched && root.scrollTop > 0) root.scrollTop = 0;
    const rm = reduced();
    const origin = root.getBoundingClientRect();
    const seen = new Set<string>();
    let fresh = 0;
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
      const key = el.dataset.flip!;
      seen.add(key);
      const old = snap.items.get(key);
      if (!old) {
        // On a switch, only once the old team has almost collapsed.
        const delay = rm ? 0 : (switched ? DUR[1] : 0) + Math.min(fresh++, 8) * STAGGER;
        this.#animate(el, [rm ? { opacity: 0 } : { opacity: 0, translate: '0 -6px' }, {}], { duration: rm ? DUR[1] : DUR[3], delay, easing: EASE.out, fill: 'backwards' });
        continue;
      }
      const rect = el.getBoundingClientRect();
      const dx = old.rect.left - rect.left;
      const dy = old.rect.top - rect.top;
      const resized = moved(old.rect.width, rect.width) || moved(old.rect.height, rect.height);
      if (!moved(dx, 0) && !moved(dy, 0) && !resized) continue;
      if (rm) {
        this.#animate(el, [{ opacity: 0 }, {}], { duration: DUR[1], easing: EASE.out });
        continue;
      }
      // Before the card slides: its parts are measured at the new position.
      if (old.parts && resized) this.#morph(el, rect, old);
      // What slides up (the chosen team) lies above what makes room.
      this.#animate(el, [{ translate: `${dx}px ${dy}px`, zIndex: dy > 0 ? 3 : 2 }, { translate: '0 0', zIndex: dy > 0 ? 3 : 2 }], { duration: DUR[4], easing: EASE.glide });
    }
    if (rm) return;
    for (const [key, { el, rect }] of snap.items) {
      if (seen.has(key)) continue;
      // Inert copy at the last seen position, in the sidebar's coordinate system (position: relative).
      const ghost = stillCopy(el);
      for (const node of [ghost, ...ghost.querySelectorAll('[data-flip], [data-part]')]) {
        node.removeAttribute('data-flip');
        node.removeAttribute('data-part');
      }
      ghost.classList.add('flip-ghost');
      Object.assign(ghost.style, { left: `${rect.left - origin.left + root.scrollLeft}px`, top: `${rect.top - origin.top + root.scrollTop}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      root.append(ghost);
      this.#fade(ghost, switched ? DUR[1] : DUR[2]);
    }
  }

  /**
   * Team card with a different size (row becomes card, card becomes row): the card itself only
   * slides (top left to top left); its parts start at their old place inside the card. Only
   * `translate`, `scale` and `opacity` are animated (origin top left, app.css).
   */
  #morph(el: HTMLElement, rect: DOMRect, old: Item) {
    const glide = { duration: DUR[4], easing: EASE.glide };
    const parts = partsOf(el);
    for (const [name, { el: part, rect: to }] of parts) {
      const from = old.parts!.get(name);
      if (!from) {
        // New on the card: counts once the old team has collapsed; the corners so they settle with the docking.
        const late = name === 'dock' ? DUR[4] - DUR[2] : DUR[1];
        this.#animate(part, [{ opacity: 0 }, {}], { duration: DUR[2], delay: late, easing: EASE.out, fill: 'backwards' });
        continue;
      }
      // Invisible (corners in the drawer): nothing to move.
      if (!to.width || !from.rect.width) continue;
      const tx = from.rect.left - old.rect.left - (to.left - rect.left);
      const ty = from.rect.top - old.rect.top - (to.top - rect.top);
      // Surface: squashed to the old size; logo: uniformly; text: only shifted.
      const sx = name === 'bg' || name === 'logo' ? from.rect.width / to.width : 1;
      const sy = name === 'bg' ? from.rect.height / to.height : sx;
      if (!moved(tx, 0) && !moved(ty, 0) && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
      this.#animate(part, [{ translate: `${tx}px ${ty}px`, scale: `${sx} ${sy}` }, { translate: '0 0', scale: '1 1' }], glide);
    }
    // Only on the old shape (counts, corners at the panel): inert copy in the card, fades out while moving with it.
    for (const [name, from] of old.parts!) {
      if (parts.has(name)) continue;
      const ghost = stillCopy(from.el);
      ghost.removeAttribute('data-part');
      ghost.classList.add('flip-ghost');
      Object.assign(ghost.style, { position: 'absolute', left: `${from.rect.left - old.rect.left}px`, top: `${from.rect.top - old.rect.top}px`, width: `${from.rect.width}px`, height: `${from.rect.height}px`, margin: '0' });
      el.append(ghost);
      this.#fade(ghost, DUR[1]);
    }
  }

  /** Fade the copy out, then remove it. */
  #fade(ghost: HTMLElement, duration: number) {
    this.#ghosts.push(ghost);
    const anim = ghost.animate([{ opacity: 1 }, { opacity: 0, translate: '0 -4px' }], { duration, easing: EASE.in, fill: 'forwards' });
    this.#anims.push(anim);
    anim.finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
  }

  #animate(el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const anim = el.animate(frames, opts);
    this.#anims.push(anim);
    void anim.finished.then(
      () => {
        const i = this.#anims.indexOf(anim);
        if (i >= 0) this.#anims.splice(i, 1);
      },
      () => {},
    );
  }

  /** End the previous motion (a new one starts, or none should run). */
  #stop() {
    for (const a of this.#anims) a.cancel();
    this.#anims = [];
    for (const g of this.#ghosts) g.remove();
    this.#ghosts = [];
  }
}

/**
 * What the sidebar shows: the state from core, but one frame later on a team switch. The response
 * frame then shows only the new content on the right; rebuilding the sidebar and starting its
 * motion would otherwise cost about 3 ms in it. Everything else (active item, counts, section
 * open/closed) applies immediately.
 */
export function deferredSidebar(source: Slice<SidebarState>): { shown: Slice<SidebarState>; stop: () => void } {
  const shown = new Slice(source.get());
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const apply = () => {
    frame = 0;
    timer = undefined;
    shown.set(source.get());
  };
  const stop = source.subscribe(() => {
    if (frame || timer) return;
    const switched = !!shown.get().current && source.get().current?.key !== shown.get().current?.key;
    if (!switched) return shown.set(source.get());
    frame = requestAnimationFrame(() => (timer = setTimeout(apply, 0)));
  });
  return {
    shown,
    stop: () => {
      stop();
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    },
  };
}
