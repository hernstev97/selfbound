import { formatShortcut, shortcutOf } from '@selfbound/core';
import { app } from '../app-instance.ts';

/** Tooltip with shortcut: "Filter · F" */
export function tip(label: string, actionId?: string) {
  const key = actionId ? shortcutOf(actionId) : undefined;
  return key ? `${label} · ${formatShortcut(key)}` : label;
}

/** Anchor below an element for anchored pickers. */
export function anchorOf(el: Element, align: 'left' | 'right' = 'left') {
  const r = el.getBoundingClientRect();
  return { x: align === 'left' ? r.left : r.right, y: r.bottom + 4, width: r.width };
}

/**
 * The `data-cell` a click in a row or card acts on. The label stack counts only for a touch tap
 * (that is how touch gets to the names, no tooltip there); a mouse click on it is a click on the row.
 */
export function cellOf(e: MouseEvent): HTMLElement | null {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
  return cell && (cell.dataset.cell !== 'labels' || (e as PointerEvent).pointerType === 'touch') ? cell : null;
}

/**
 * Attachment for overlays that live only in the UI (settings dialogs, small popovers): while the
 * element exists, Back (Android gesture, browser) closes it with `close` instead of changing the
 * page. Core's overlays are registered by core/app/index.ts itself.
 */
export const backCloses = (close: () => void) => () => app.nav.hold(() => close());

/** Attachment: focus the element when it appears. */
export function autofocus(node: HTMLElement) {
  queueMicrotask(() => node.focus({ preventScroll: true }));
}

/**
 * Attachment: keep a popover inside the window (no clipping at right/bottom). Runs before the first
 * paint, so the picker appears at the right place right away instead of jumping a frame later.
 * Size from offsetWidth/-Height, so the fade-in scale does not count.
 */
export function keepInView(node: HTMLElement) {
  const r = node.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  if (r.left + width > innerWidth - 8) node.style.left = `${Math.max(8, innerWidth - width - 8)}px`;
  if (r.top + height > innerHeight - 8) node.style.top = `${Math.max(8, r.top - height - 40)}px`;
}

/** Attachment: long press (phone) opens the context menu. */
export const longpress = (cb: (x: number, y: number) => void) => (node: HTMLElement) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const { clientX, clientY } = e;
    timer = setTimeout(() => {
      timer = null;
      cb(clientX, clientY);
    }, 480);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  node.addEventListener('pointerdown', start);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointermove', cancel);
  node.addEventListener('pointercancel', cancel);
  return () => {
    cancel();
    node.removeEventListener('pointerdown', start);
    node.removeEventListener('pointerup', cancel);
    node.removeEventListener('pointermove', cancel);
    node.removeEventListener('pointercancel', cancel);
  };
};

// ---------------------------------------------------------------- Identifier column

const keyWidths = new Map<string, number>();
let ctx2d: CanvasRenderingContext2D | null = null;
/** Identifier font size per setting (like --fs-small in app.css) */
const KEY_FONT_PX: Record<string, number> = { small: 12, normal: 13, large: 14 };

/**
 * Width of the identifier column in px: measures the patterns ("NOVA-0000") with the same font as
 * `.row-key` (Inter 400). Via canvas instead of a DOM element: a measuring element in the document
 * forces a layout of the whole page on first paint (~20 ms on a warm start at 4× CPU throttling).
 * The patterns consist of zeros; in Inter the zero is as wide as the tabular digits.
 * Cached per pattern and font size.
 */
export function keyColumnWidth(samples: readonly string[], font: string): number {
  if (samples.length === 0 || typeof document === 'undefined') return 56;
  const px = KEY_FONT_PX[font.split(':')[0]] ?? 13;
  let max = 0;
  for (const sample of samples) {
    const key = `${font}|${sample}`;
    let w = keyWidths.get(key);
    if (w === undefined) {
      ctx2d ??= document.createElement('canvas').getContext('2d');
      if (!ctx2d) return 72;
      ctx2d.font = `400 ${px}px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif`;
      w = ctx2d.measureText(sample).width;
      keyWidths.set(key, w);
    }
    if (w > max) max = w;
  }
  return Math.max(40, Math.ceil(max) + 2);
}

export function clearKeyWidths() {
  keyWidths.clear();
}
