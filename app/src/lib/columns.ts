// Column stages of the list, like a grouped table:
//   wide    properties in fixed columns, aligned under each other, icons in the group header
//   medium  like wide, but without labels
//   narrow  columns slide right after the title, header icons disappear
// The stage is set as `data-stage` on the list (ListView, from the list's ResizeObserver); it only
// changes when a threshold is crossed. CSS does the rest (app.css, "column stages"). This used to
// be a container query, which cost noticeably on every row change (an agent edit went from 32 to
// 50 ms in benchmarks) because the browser then recalculates more style.
import type { DisplayProp } from '@selfbound/core';
import { PROP_LABEL } from '@selfbound/core';
import { ROW_COLUMNS, ROW_END } from './rowHtml.ts';

/** Fixed column widths in px (wide and medium), same as app.css; when narrow each column is as wide as its content. */
export const COLUMN_WIDTH: Record<(typeof ROW_COLUMNS)[number], number> = {
  labels: 184,
  project: 168,
  sprint: 136,
  model: 176,
  estimate: 40,
  due: 84,
};
/** Date columns at the far right (app.css `.row-date`) */
const END_WIDTH = 44;
const GAP = 8;
/** Title: at least this much room stays before the next stage applies */
const TITLE_MIN = 240;
/** Row: list margin (8 + 8), padding left 26 and right 32 (app.css `.row`) */
const ROW_CHROME = 16 + 26 + 32;
/** Priority, team logo, status: 16 px each plus gap */
const ICON = 16 + GAP;

export interface ColumnPlan {
  /** From this list width: wide (all columns aligned) */
  wide: number;
  /** From this width: medium (no labels); equals `wide` when no labels are shown */
  mid: number;
}

/** Thresholds for the visible properties; `idWidth`: measured identifier column. */
export function columnPlan(props: ReadonlySet<DisplayProp>, idWidth: number): ColumnPlan {
  let lead = ROW_CHROME + TITLE_MIN;
  if (props.has('priority')) lead += ICON;
  if (props.has('team')) lead += ICON;
  if (props.has('id')) lead += idWidth + GAP;
  if (props.has('status')) lead += ICON;
  let cols = 0;
  for (const prop of ROW_COLUMNS) if (props.has(prop)) cols += COLUMN_WIDTH[prop] + GAP;
  for (const prop of ROW_END) if (props.has(prop)) cols += END_WIDTH + GAP;
  const wide = lead + cols;
  const mid = props.has('labels') ? wide - COLUMN_WIDTH.labels - GAP : wide;
  return { wide, mid };
}

export type Stage = 'wide' | 'mid' | 'narrow';

/** Stage for the list width (clientWidth). */
export function stageOf(width: number, plan: ColumnPlan): Stage {
  if (width >= plan.wide) return 'wide';
  if (width >= plan.mid) return 'mid';
  return 'narrow';
}

/** Icons in the group header (above the columns), built once per display setting as HTML for all headers. */
const HEAD_ICON: Partial<Record<DisplayProp, string>> = {
  due: 'i-calendar',
  estimate: 'i-estimate',
  sprint: 'i-sprint',
  model: 'ui-model',
  project: 'ui-projects',
  labels: 'ui-label',
  snoozed: 'ui-snooze',
  updated: 'ui-edit',
  created: 'ui-compose',
};
const ROW_COLUMNS_RTL = [...ROW_COLUMNS].reverse();
const ROW_END_RTL = [...ROW_END].reverse();

export function groupColsHtml(props: ReadonlySet<DisplayProp>): string {
  const cell = (p: DisplayProp, cls: string) => `<span class="c${cls}" title="${PROP_LABEL[p]}"><span class="icon mi ${HEAD_ICON[p]}"></span></span>`;
  // Right to left like the row cells (row-reverse).
  let html = '<span class="group-cols" aria-hidden="true">';
  for (const p of ROW_COLUMNS_RTL) if (props.has(p)) html += cell(p, ` c-${p}`);
  html += '</span>';
  const end = ROW_END_RTL.filter((p) => props.has(p));
  if (end.length) html += `<span class="group-end" aria-hidden="true">${end.map((p) => cell(p, '')).join('')}</span>`;
  return html;
}
