// Modal overlays: dialogs, the command menu and pickers share this base. It locks the background
// (`inert`: mouse, keyboard, screen readers), keeps Tab inside the dialog, sets the first focus and
// returns it on close to the element that opened the dialog.
// Usage: `{@attach modal()}` on the element with `out:leave` (or on the dialog itself).
// Closing works as before (Esc in core/app/keys.ts or in the dialog); there are no keys for it here.
//
// State and focus switch immediately (ground rule in motion.ts): as soon as Svelte sets `inert` on
// the element to fade it out, the dialog is released, not only when it is removed after 90 ms.
//
// Deliberately not modal: context menu, display options, peek and the editor's language picker.
// They lock nothing; focus stays where it was, and Esc and clicking outside close them as before.

export interface ModalOptions {
  /** Tab and Shift Tab cycle inside the dialog. Off for the command menu, where Tab picks an entry (core/app/keys.ts). */
  trap?: boolean;
  /** Set focus on open if nothing in the dialog has it yet (first `[data-autofocus]`, otherwise the first focusable element). */
  focus?: boolean;
}

/** Open overlays, topmost last. Only it traps Tab. */
const stack: Modal[] = [];

/** Elements locked by open overlays: how often, and whether they were `inert` before. */
const locks = new Map<Element, { count: number; before: boolean }>();
/** Overlays that are fading out: their `inert` belongs to Svelte and stays. */
const leaving = new WeakSet<Element>();
/** Opener of an overlay while it fades out: if the next one opens from it right away (command menu → dialog), it inherits the opener. */
const openers = new WeakMap<Element, HTMLElement | null>();
let lastRelease: { opener: HTMLElement | null; at: number } | null = null;

const TABBABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => {
    if (el.tabIndex < 0 || el.matches(':disabled') || el.closest('[inert]')) return false;
    return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
}

function usable(el: HTMLElement | null): el is HTMLElement {
  return !!el && el.isConnected && !el.closest('[inert]') && el.getClientRects().length > 0;
}

/** Locks everything except the path from `node` to <body> (siblings at every level). Live regions (toasts) and background scrims stay. */
function lock(node: Element): Element[] {
  const held: Element[] = [];
  for (let el: Element = node; el !== document.body && el.parentElement; el = el.parentElement) {
    for (const sibling of el.parentElement.children) {
      if (sibling === el || sibling.matches('script, style, link, template, [aria-live], [data-scrim]')) continue;
      const entry = locks.get(sibling) ?? { count: 0, before: (sibling as HTMLElement).inert };
      entry.count++;
      locks.set(sibling, entry);
      (sibling as HTMLElement).inert = true;
      held.push(sibling);
    }
  }
  return held;
}

function unlock(held: Element[]) {
  for (const el of held) {
    const entry = locks.get(el);
    if (!entry) continue;
    if (--entry.count > 0) continue;
    locks.delete(el);
    // Locked before (e.g. the hidden list behind an issue), fading out, or hidden from the page's point
    // of view (`aria-hidden`): that `inert` is not ours.
    if (entry.before || leaving.has(el) || el.getAttribute('aria-hidden') === 'true') continue;
    (el as HTMLElement).inert = false;
  }
}

class Modal {
  held: Element[] = [];
  opener: HTMLElement | null = null;
  open = false;

  constructor(
    readonly node: HTMLElement,
    readonly dialog: HTMLElement,
    readonly options: ModalOptions,
  ) {}

  acquire() {
    if (this.open) return;
    this.open = true;
    leaving.delete(this.node);
    openers.delete(this.node);
    stack.push(this);
    this.held = lock(this.node);
  }

  release() {
    if (!this.open) return;
    this.open = false;
    leaving.add(this.node);
    openers.set(this.node, this.opener);
    lastRelease = { opener: this.opener, at: performance.now() };
    stack.splice(stack.indexOf(this), 1);
    unlock(this.held);
    this.held = [];
    // Back to the opener, unless the app has deliberately moved focus elsewhere.
    const active = document.activeElement;
    const free = !active || active === document.body || this.node.contains(active);
    const opener = this.opener;
    if (!free || !usable(opener) || this.node.contains(opener)) return;
    opener.focus({ preventScroll: true });
    // If a click on the backdrop closed the dialog (pointerdown), the browser takes focus away again after the click.
    setTimeout(() => {
      if (document.activeElement === document.body && usable(opener)) opener.focus({ preventScroll: true });
    });
  }
}

/** Overlays Svelte is already fading out (`inert`) that the observer has not reported yet: whatever opens in the same tick inherits their opener. */
function sweep() {
  for (const m of [...stack]) if (m.node.inert && !locks.has(m.node)) m.release();
}

/** Where did focus come from? If a dialog sets focus itself (input on mount), it is already inside when locking. */
const cameFrom = new WeakMap<Element, Element | null>();
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => e.target instanceof Element && cameFrom.set(e.target, e.relatedTarget instanceof Element ? e.relatedTarget : null), true);
}

/** Who opened the overlay? The focused element, otherwise (focus on <body>) the opener of one that just closed. */
function openerNow(node: HTMLElement): HTMLElement | null {
  let active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    if (node.contains(active)) active = cameFrom.get(active) ?? null;
    for (let el: Element | null = active; el; el = el.parentElement) if (openers.has(el)) return openers.get(el) ?? null;
    return active instanceof HTMLElement && !node.contains(active) ? active : null;
  }
  return lastRelease && performance.now() - lastRelease.at < 400 ? lastRelease.opener : null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    const top = stack.at(-1);
    if (!top?.options.trap || e.key !== 'Tab' || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    const items = tabbables(top.dialog);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      e.preventDefault();
      top.dialog.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    // At the edges or outside the list (dialog itself, <body>, non-focusable element) we jump; otherwise the browser decides.
    if (e.shiftKey && (active === first || !items.includes(active as HTMLElement))) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    } else if (!top.dialog.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
    }
  });
}

/**
 * Attachment for a modal overlay. `node` is the element with `out:leave`; the dialog is the element
 * itself or its first `[role="dialog"]`.
 */
export function modal(options: ModalOptions = {}) {
  const { trap = true, focus = true } = options;
  return (node: HTMLElement) => {
    const dialog = node.matches('[role="dialog"]') ? node : (node.querySelector<HTMLElement>('[role="dialog"]') ?? node);
    const m = new Modal(node, dialog, { trap, focus });
    sweep();
    m.opener = openerNow(node);
    m.acquire();
    // First focus: if nothing in the dialog has focus on open, the marked or the first focusable element gets it.
    const focusFirst = () => {
      if (!focus) return;
      queueMicrotask(() => {
        if (!m.open || dialog.contains(document.activeElement)) return;
        const target = dialog.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(dialog)[0];
        if (target) target.focus({ preventScroll: true });
        else {
          if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
          dialog.focus({ preventScroll: true });
        }
      });
    };
    focusFirst();
    // Fade out: release at once. Svelte sets `inert` on the element for that (`outrostart` would come a frame later).
    // If the element comes back before removal, Svelte lifts `inert` again: then we lock again. An `inert` we set
    // ourselves (an overlay above) does not count.
    const watch = new MutationObserver(() => {
      if (node.inert && !locks.has(node)) m.release();
      else if (!node.inert && !m.open) {
        m.acquire();
        focusFirst();
      }
    });
    watch.observe(node, { attributes: true, attributeFilter: ['inert'] });
    return () => {
      watch.disconnect();
      m.release();
    };
  };
}
