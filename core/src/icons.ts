// Icons as SVG text (own icons only, never user data). Inserted with {@html}.
// Cut-out shapes use --icon-cut (default: panel color).
import type { Priority, Status } from './types.ts';

const CUT = 'var(--icon-cut, var(--bg-panel))';

const STATUS_COLOR: Record<Status, string> = {
  triage: 'var(--status-triage)',
  backlog: 'var(--status-backlog)',
  todo: 'var(--status-todo)',
  in_progress: 'var(--status-progress)',
  in_review: 'var(--status-review)',
  done: 'var(--status-done)',
  canceled: 'var(--status-canceled)',
  duplicate: 'var(--status-canceled)',
};

const svg16 = (body: string, attrs = 'fill="none"') =>
  `<svg viewBox="0 0 16 16" width="16" height="16" ${attrs} aria-hidden="true">${body}</svg>`;

const STATUS_BODY: Record<Status, string> = {
  backlog: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.4 1.74" stroke-dashoffset="0.7" transform="rotate(-90 8 8)"/>',
  todo: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>',
  in_progress: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5A3.5 3.5 0 0 1 8 11.5Z" fill="currentColor"/>',
  in_review: '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/><path d="M8 8V4.5A3.5 3.5 0 1 1 4.5 8Z" fill="currentColor"/>',
  done: `<circle cx="8" cy="8" r="6.75" fill="currentColor"/><path d="M5.25 8.1 7.15 10l3.6-3.7" stroke="${CUT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  canceled: `<circle cx="8" cy="8" r="6.75" fill="currentColor"/><path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" stroke="${CUT}" stroke-width="1.5" stroke-linecap="round"/>`,
  duplicate: `<circle cx="8" cy="8" r="6.75" fill="currentColor"/><path d="m5.4 8.6 3.2-3.2m-1.2 5.2 3.2-3.2" stroke="${CUT}" stroke-width="1.5" stroke-linecap="round"/>`,
  triage: `<circle cx="8" cy="8" r="6.75" fill="currentColor"/><path d="M3.9 8 6.4 5.6v1.6h3.2V5.6L12.1 8 9.6 10.4V8.8H6.4v1.6Z" fill="${CUT}"/>`,
};

/** Status icon with its own color (per-team status); without a color the icon of the status type. */
export function statusIcon(status: Status, color?: string | null): string {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return STATUS_ICON[status];
  return svg16(STATUS_BODY[status], `fill="none" style="color:${color}"`);
}

export const STATUS_ICON: Record<Status, string> = Object.fromEntries(
  (Object.keys(STATUS_BODY) as Status[]).map((s) => [s, svg16(STATUS_BODY[s], `fill="none" style="color:${STATUS_COLOR[s]}"`)]),
) as Record<Status, string>;

const PRIORITY_BODY: Record<Priority, string> = {
  0: '<rect x="1.5" y="7.25" width="3" height="1.5" rx=".5"/><rect x="6.5" y="7.25" width="3" height="1.5" rx=".5"/><rect x="11.5" y="7.25" width="3" height="1.5" rx=".5"/>',
  4: '<rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1" fill-opacity=".4"/><rect x="11.5" y="2" width="3" height="12" rx="1" fill-opacity=".4"/>',
  3: '<rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1"/><rect x="11.5" y="2" width="3" height="12" rx="1" fill-opacity=".4"/>',
  2: '<rect x="1.5" y="8" width="3" height="6" rx="1"/><rect x="6.5" y="5" width="3" height="9" rx="1"/><rect x="11.5" y="2" width="3" height="12" rx="1"/>',
  1: `<rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor"/><rect x="7.25" y="3.75" width="1.5" height="5.5" rx=".75" fill="${CUT}"/><circle cx="8" cy="11.4" r="1" fill="${CUT}"/>`,
};

export const PRIORITY_ICON: Record<Priority, string> = {
  0: svg16(PRIORITY_BODY[0], 'fill="currentColor" class="prio prio-0"'),
  1: svg16(PRIORITY_BODY[1], 'class="prio prio-1"'),
  2: svg16(PRIORITY_BODY[2], 'fill="currentColor" class="prio"'),
  3: svg16(PRIORITY_BODY[3], 'fill="currentColor" class="prio"'),
  4: svg16(PRIORITY_BODY[4], 'fill="currentColor" class="prio"'),
};

const stroke = (d: string) => svg16(`<path d="${d}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`);

/** UI icons (16 px). */
export const ICON = {
  priority: svg16(PRIORITY_BODY[2], 'fill="currentColor"'),
  inbox: stroke('M2.5 9.5h3l1 1.5h3l1-1.5h3M3.6 3.5h8.8l1.1 6V12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2.5 12V9.5Z'),
  triage: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M5 8l1.6-1.5v1h2.8v-1L11 8 9.4 9.5v-1H6.6v1Z" fill="currentColor"/>'),
  issues: stroke('M5.5 2.5h6a2 2 0 0 1 2 2v6M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z'),
  all: stroke('M3 4h10M3 8h10M3 12h10'),
  active: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.75a3.25 3.25 0 0 1 0 6.5Z" fill="currentColor"/>'),
  backlog: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3" stroke-dasharray="1.4 1.6"/>'),
  projects: stroke('M8 2 13.5 5v6L8 14 2.5 11V5L8 2Zm0 0v0M2.5 5 8 8l5.5-3M8 8v6'),
  sprint: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 5.6v4.8L10.4 8Z" fill="currentColor"/>'),
  trash: stroke('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1'),
  settings: svg16('<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.4 3.6l-1.06 1.06M4.66 11.34 3.6 12.4M12.4 12.4l-1.06-1.06M4.66 4.66 3.6 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="8" r="4.6" stroke="currentColor" stroke-width="1.3"/>'),
  search: stroke('M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm3.6-1.4L14 14'),
  compose: stroke('M13 8.5V12a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V5a1.5 1.5 0 0 1 1.5-1.5H8M11.5 2.5l2 2L8 10H6V8l5.5-5.5Z'),
  filter: stroke('M2.5 4h11M4.5 8h7M6.5 12h3'),
  display: stroke('M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1M8 3v3M11 10v3'),
  sidebar: stroke('M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM6.5 2.5v11'),
  /** Split view: issue pane on the right */
  split: stroke('M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM8.5 2.5v11'),
  chevronDown: stroke('M4.5 6.5 8 10l3.5-3.5'),
  chevronRight: stroke('M6.5 4.5 10 8l-3.5 3.5'),
  chevronLeft: stroke('M9.5 4.5 6 8l3.5 3.5'),
  chevronUp: stroke('M4.5 9.5 8 6l3.5 3.5'),
  caretDown: svg16('<path d="M5 6.5h6L8 10Z" fill="currentColor"/>'),
  caretRight: svg16('<path d="M6.5 5v6L10 8Z" fill="currentColor"/>'),
  plus: stroke('M8 3.5v9M3.5 8h9'),
  close: stroke('m4.5 4.5 7 7m0-7-7 7'),
  check: stroke('m3.5 8.5 3 3 6-7'),
  more: svg16('<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>'),
  star: stroke('m8 2.5 1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8-2.8-2.7 3.8-.5L8 2.5Z'),
  link: stroke('M7 9a2.5 2.5 0 0 0 3.5 0l2-2A2.5 2.5 0 0 0 9 3.5l-.7.7M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7'),
  branch: stroke('M5 3v10M5 13a1.5 1.5 0 1 0 0-.01M11 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 0c0 3-6 2.5-6 5'),
  label: stroke('M2.5 4v3.6a1 1 0 0 0 .3.7l5 5a1 1 0 0 0 1.4 0l3.6-3.6a1 1 0 0 0 0-1.4l-5-5a1 1 0 0 0-.7-.3H3.5a1 1 0 0 0-1 1ZM5.5 6h.01'),
  estimate: svg16('<path d="M8 2.75 13.5 12.5h-11Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6v6.5" stroke="currentColor" stroke-width="1.3"/>'),
  calendar: stroke('M3.5 3.5h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM2.5 6.5h11M5.5 2v2.5M10.5 2v2.5'),
  snooze: stroke('M13 9.2A5.5 5.5 0 1 1 6.8 3 4.3 4.3 0 0 0 13 9.2Z'),
  parent: stroke('M4 3v4a2 2 0 0 0 2 2h6m-2.5-2.5L12 9l-2.5 2.5'),
  subissue: stroke('M4 3v6a2 2 0 0 0 2 2h6m-2.5-2.5L12 11l-2.5 2.5'),
  relation: stroke('M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1'),
  blocked: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="m4 12 8-8" stroke="currentColor" stroke-width="1.3"/>'),
  duplicate: stroke('M5.5 5.5h7v7h-7zM3.5 10.5v-7h7'),
  copy: stroke('M5.5 5.5h7v7h-7zM3.5 10.5v-7h7'),
  user: svg16('<circle cx="8" cy="5.5" r="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M3.5 13.5c.4-2.4 2.2-4 4.5-4s4.1 1.6 4.5 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
  team: stroke('M5.5 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM2 13c.4-2 1.8-3.5 3.5-3.5S8.6 11 9 13M11 7.5a1.7 1.7 0 1 0 0-3.4M12 9.6c1 .5 1.8 1.7 2 3.4'),
  comment: stroke('M3 3.5h10a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H7l-3 2.5v-2.5H3a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z'),
  model: stroke('M5.5 4.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2M7 7h2v2H7Z'),
  agent: svg16('<rect x="3" y="5" width="10" height="8" rx="2.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.5V5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.2" cy="9" r=".95" fill="currentColor"/><circle cx="9.8" cy="9" r=".95" fill="currentColor"/>'),
  github: svg16('<path fill="currentColor" d="M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.44-.14.44-.31v-1.1c-1.8.39-2.18-.86-2.18-.86-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.52.71 1.9.54.05-.42.22-.71.4-.87-1.44-.16-2.95-.72-2.95-3.2 0-.71.25-1.29.67-1.74-.07-.17-.29-.83.06-1.72 0 0 .55-.18 1.79.66a6.2 6.2 0 0 1 3.26 0c1.24-.84 1.78-.66 1.78-.66.36.9.13 1.55.07 1.72.42.45.67 1.03.67 1.74 0 2.49-1.52 3.04-2.96 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.38.45.31A6.5 6.5 0 0 0 8 1.5Z"/>'),
  import: stroke('M8 2.5v7m-3-3 3 3 3-3M3 11v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V11'),
  system: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M8 5v3l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'),
  edit: stroke('M10.5 3.5l2 2L6 12H4v-2l6.5-6.5Z'),
  restore: stroke('M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.5H6'),
  eye: stroke('M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z'),
  open: stroke('M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3'),
  /** Open at full size (PR next to the issue) */
  expand: stroke('M9.5 2.5h4v4M13.5 2.5 9.5 6.5M6.5 13.5h-4v-4M2.5 13.5l4-4'),
  undo: stroke('M5 3 2.5 5.5 5 8M2.5 5.5h6.5a4 4 0 0 1 0 8H6'),
  redo: stroke('M11 3l2.5 2.5L11 8M13.5 5.5H7a4 4 0 0 0 0 8h3'),
  board: stroke('M3.5 2.5h2a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM7 2.5h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7M10.5 2.5h2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-2'),
  list: stroke('M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01'),
  keyboard: stroke('M2.5 4.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6'),
  theme: svg16('<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor"/>'),
  select: svg16('<rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" stroke-width="1.3"/><path d="m5.5 8 1.8 1.8 3.2-3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  menu: stroke('M2.5 4.5h11M2.5 8h11M2.5 11.5h11'),
  back: stroke('M10 3.5 5.5 8l4.5 4.5'),
  arrowUp: stroke('M8 13V3M4 7l4-4 4 4'),
  arrowDown: stroke('M8 3v10M4 9l4 4 4-4'),
  gauge: stroke('M3 11a5 5 0 1 1 10 0M8 11l2.5-3'),
  bell: stroke('M4 11.5V7a4 4 0 1 1 8 0v4.5l1 1H3l1-1ZM6.5 14h3'),
  warning: stroke('M8 2.5 14 13H2L8 2.5ZM8 6.5v3M8 11.25h.01'),
  pr: stroke('M5 3v10M5 3a1.5 1.5 0 1 1 0 .01M11 13a1.5 1.5 0 1 1 0-.01M11 11.5V6a2 2 0 0 0-2-2H7.5m1.5-1.5L7.5 4 9 5.5'),
  wiki: stroke('M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5H4.5A1.5 1.5 0 0 0 3 14V3.5ZM3 14a1.5 1.5 0 0 1 1.5-1.5H13M6 5h4'),
  page: stroke('M4.5 2h5l3 3v8.5a.5.5 0 0 1-.5.5h-7.5a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5ZM9.5 2v3h3M6 8.5h4M6 11h4'),
  cloudOff: stroke('M3 3l10 10M5.5 5.6A3.5 3.5 0 0 0 4.5 12.5h6.5M11.8 12.3A2.5 2.5 0 0 0 12 7.5h-.1A4 4 0 0 0 7.6 4.5'),
} as const;

export type IconName = keyof typeof ICON;

export const CHECK_ICON = ICON.check;

// ---------------------------------------------------------------- Masks for list rows
//
// In list rows, status, priority and small pill icons are not inline SVG (3–5 DOM nodes per icon
// and row) but a CSS mask on a pseudo-element: one node per cell. The color still comes from
// `color`; cut-out shapes (check mark in "Done", "!" in "Urgent") are truly transparent instead of
// painted in the panel color.

const ELEMENT_RE = /<(circle|path|rect)\b[^>]*\/>/g;

/** SVG body (as above) → mask SVG as a data: URL for `mask-image`. */
export function maskUrl(body: string): string {
  const keep: string[] = [];
  const cut: string[] = [];
  for (const el of body.match(ELEMENT_RE) ?? []) {
    const white = el.replaceAll('currentColor', '#fff');
    if (el.includes(CUT)) cut.push(el.replaceAll(CUT, '#000'));
    else keep.push(white.includes('fill=') || white.includes('stroke=') ? white : white.replace('/>', ' fill="#fff"/>'));
  }
  const inner = cut.length
    ? `<mask id="c"><rect width="16" height="16" fill="#fff"/>${cut.join('')}</mask><g mask="url(#c)">${keep.join('')}</g>`
    : keep.join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none">${inner}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const PILL_BODY = {
  estimate: '<path d="M8 2.75 13.5 12.5h-11Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6v6.5" stroke="currentColor" stroke-width="1.3"/>',
  sprint: '<circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 5.6v4.8L10.4 8Z" fill="currentColor"/>',
  calendar: '<path d="M3.5 3.5h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1ZM2.5 6.5h11M5.5 2v2.5M10.5 2v2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="m3.5 8.5 3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
};

/**
 * CSS for the mask icons of list rows: `.mi.s-<status>`, `.mi.p-<priority>`,
 * `.mi.i-estimate|sprint|calendar|check`. Inserted once at startup as <style>.
 */
export function rowIconCss(): string {
  const rules: string[] = [];
  for (const [status, body] of Object.entries(STATUS_BODY)) rules.push(`.s-${status}{color:${STATUS_COLOR[status as Status]}}.s-${status}::before{mask-image:${maskUrl(body)}}`);
  for (const [priority, body] of Object.entries(PRIORITY_BODY)) rules.push(`.p-${priority}::before{mask-image:${maskUrl(body)}}`);
  for (const [name, body] of Object.entries(PILL_BODY)) rules.push(`.i-${name}::before{mask-image:${maskUrl(body)}}`);
  // All UI icons too (sidebar, headers, group headers): .mi.ui-<name>
  for (const [name, svg] of Object.entries(ICON)) rules.push(`.ui-${name}::before{mask-image:${maskUrl(svg.replace(/^<svg[^>]*>|<\/svg>$/g, ''))}}`);
  return rules.join('\n');
}
