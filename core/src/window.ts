// Windowing for virtualized lists: which rows are visible?
// Lives in core so that no virtualization library influences the result.
// All rows of a list have the same fixed height (44 px).

export const ROW_HEIGHT = 44;
/** Phone: larger touch targets */
export const ROW_HEIGHT_MOBILE = 52;
/** Inbox: two-line entries */
export const INBOX_ROW_HEIGHT = 60;
export const OVERSCAN = 6;
/** Space above the first row (group header sits 8 px below the view bar) */
export const LIST_PADDING = 0;

export interface Range {
  start: number;
  end: number; // exclusive
}

export function computeWindow(scrollTop: number, viewport: number, itemHeight: number, count: number, overscan = OVERSCAN): Range {
  if (count === 0) return { start: 0, end: 0 };
  // Height still unknown (first render): assume the window height instead of a flat 40 entries
  // (otherwise far too many rows are created and dropped right away).
  if (!(viewport > 0)) viewport = globalThis.innerHeight || 900;
  const first = Math.floor(Math.max(0, scrollTop) / itemHeight);
  const visible = Math.ceil(viewport / itemHeight) + 1;
  return {
    start: Math.max(0, Math.min(first, count) - overscan),
    end: Math.min(count, first + visible + overscan),
  };
}

export function sameRange(a: Range, b: Range) {
  return a.start === b.start && a.end === b.end;
}

/**
 * Scrolls a container so that entry `index` is fully visible. `bottomMargin`: keep this much free at
 * the bottom (e.g. for notices at the bottom right, so the row does not sit below them).
 */
export function revealIndex(el: { scrollTop: number; clientHeight: number }, index: number, itemHeight: number, padding = 0, bottomMargin = 0) {
  const top = index * itemHeight + padding;
  const bottom = top + itemHeight;
  const visible = Math.max(itemHeight, el.clientHeight - bottomMargin);
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + visible) el.scrollTop = bottom - visible;
}
