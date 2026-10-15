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
  revealSpan(el, top, top + itemHeight, bottomMargin);
}

/** Like `revealIndex` for an entry of any height: scrolls so that [top, bottom) is visible (top wins if it is taller). */
export function revealSpan(el: { scrollTop: number; clientHeight: number }, top: number, bottom: number, bottomMargin = 0) {
  const visible = Math.max(bottom - top, el.clientHeight - bottomMargin);
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + visible) el.scrollTop = bottom - visible;
}

// Entries of different heights (board cards): `offsets[i]` is the top of entry i, `offsets[count]`
// the end of the last one. Heights not measured yet count as `estimate`.

/** Top of every entry (plus the end) from measured heights; `gap` sits below each entry. */
export function buildOffsets(ids: readonly string[], measured: ReadonlyMap<string, number>, estimate: number, gap: number): Float64Array {
  const offsets = new Float64Array(ids.length + 1);
  let y = 0;
  for (let i = 0; i < ids.length; i++) {
    offsets[i] = y;
    y += (measured.get(ids[i]) ?? estimate) + gap;
  }
  offsets[ids.length] = y;
  return offsets;
}

/** Entry containing position `y` (the last one whose top is at or above it), clamped to the entries. */
export function indexAt(offsets: Float64Array, y: number) {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Window over entries of different heights, with `overscan` entries on both sides. */
export function computeVariableWindow(offsets: Float64Array, scrollTop: number, viewport: number, overscan = OVERSCAN): Range {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  if (!(viewport > 0)) viewport = globalThis.innerHeight || 900;
  const top = Math.max(0, scrollTop);
  return {
    start: Math.max(0, indexAt(offsets, top) - overscan),
    end: Math.min(count, indexAt(offsets, top + viewport) + 1 + overscan),
  };
}
