// Content of a list row as an HTML string (one {@html} block instead of many Svelte blocks).
//
// Why: each row used to have over 60 DOM nodes (inline SVGs, whitespace text nodes, a comment
// anchor per {#if}). Here only the visible elements and their text are created; icons are CSS
// masks. Clicks on status/priority go through `data-cell` on the row.
//
// ALL user text (title, labels, project, team, logo URL) goes through `esc`.
import type { DisplayProp, RowState, TeamBadge } from '@selfbound/core';
import { t } from '@selfbound/core/i18n';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (text: string | number) => String(text).replace(/[&<>"']/g, (c) => ESC[c]);

/** Fixed row texts, translated once on first render (rows are a hot path), already escaped. */
let fixed: ReturnType<typeof fixedTexts> | null = null;
function fixedTexts() {
  return {
    due: esc(t('Due')),
    snoozed: esc(t('Snoozed until')),
    estimate: esc(t('Estimate')),
    model: esc(t('Model')),
    modelInherited: esc(t('Model, inherited from the parent issue or the team default')),
    lateTip: esc(t('Added to the sprint later')),
    activeTip: esc(t('In the active sprint')),
    plannedTip: esc(t('In the planned sprint')),
    late: esc(t('added later')),
    restore: esc(t('Restore')),
    updated: esc(t('Updated')),
    created: esc(t('Created')),
    saving: esc(t('saving')),
  };
}
const T = () => (fixed ??= fixedTexts());

/** Team logo like TeamLogo.svelte: image, otherwise the key's letter on the team color. `data-letter` is the fallback on load errors. */
export function teamLogoHtml(team: TeamBadge, cls = '', size?: 14) {
  const sizeCls = size === 14 ? ' s14' : '';
  const letter = esc(team.key.slice(0, 1));
  if (team.logo) return `<span class="team-logo img${sizeCls} ${cls}" title="${esc(team.name)}" data-logo="img" data-letter="${letter}" style="--hue:${team.hue}"><img src="${esc(team.logo)}" alt="" loading="lazy" decoding="async"></span>`;
  return `<span class="team-logo${sizeCls} ${cls}" style="--hue:${team.hue}" title="${esc(team.name)}">${letter}</span>`;
}

/** Row columns: aligned under each other when wide, right after the title when narrow. */
export const ROW_COLUMNS = ['labels', 'project', 'sprint', 'model', 'estimate', 'due'] as const satisfies readonly DisplayProp[];
/** At the far right, at any width: date columns. */
export const ROW_END = ['snoozed', 'created', 'updated'] as const satisfies readonly DisplayProp[];

/** Label chips per stack; any further labels are counted in one "+n" chip. */
const STACK_MAX = 3;

/**
 * Label stack (list column and board card, styles: app.css "Label stack"): up to three chips in
 * their natural width, each overlapping the end of the one before it. When the room is short the
 * chips shrink and slide under their right neighbor (the last one stays whole), down to the colored
 * dot. More than three labels end in one "+n" chip with overlapping dots; the names of those are its
 * tooltip. `cls` goes on the wrapper; a tap on it opens the label picker (`data-cell`, see `cellOf`:
 * how touch screens get to the full names).
 */
export function labelStackHtml(labels: RowState['labels'], cls: string) {
  const n = labels.length;
  if (!n) return `<span class="${cls}"></span>`;
  const shown = Math.min(n, STACK_MAX);
  let html = '';
  for (let k = 0; k < shown; k++) {
    const label = labels[k];
    html += `<span class="pill label" style="--hue:${label.hue}" title="${esc(label.name)}">${esc(label.name)}</span>`;
  }
  const rest = n - shown;
  if (rest > 0) {
    let hues = '';
    for (let i = 0; i < Math.min(rest, 3); i++) hues += `--c${i}:${labels[shown + i].hue};`;
    let names = labels[shown].name;
    for (let i = shown + 1; i < n; i++) names += `, ${labels[i].name}`;
    html += `<span class="more d${Math.min(rest, 3)}" style="--n:${String(rest).length};${hues}" title="${esc(names)}">+${rest}</span>`;
  }
  return `<span class="${cls} lstack" data-cell="labels">${html}</span>`;
}

/**
 * Columns in reverse order (flex `row-reverse`): what no longer fits when narrow wraps into a
 * clipped second line and disappears as a whole, project first, due date last. Every enabled
 * column is in the DOM, as an empty placeholder without a value, so the columns stay aligned in the
 * wide view (fixed widths, app.css `.c-…`). Pills sit in their own cell so they are only as wide as
 * their text inside the fixed column.
 */
function colsHtml(r: RowState, props: ReadonlySet<DisplayProp>) {
  const tx = T();
  let html = '';
  if (props.has('due')) html += r.due ? `<span class="c c-due"><span class="pill p-due mi i-calendar${r.due.overdue ? ' overdue' : ''}${r.due.soon ? ' soon' : ''}" title="${tx.due}">${esc(r.due.label)}</span></span>` : '<span class="c c-due"></span>';
  if (props.has('estimate')) html += r.estimate !== null ? `<span class="c c-estimate row-est mi i-estimate" title="${tx.estimate}">${esc(r.estimate)}</span>` : '<span class="c c-estimate"></span>';
  if (props.has('model')) {
    html += r.model
      ? `<span class="c c-model"><span class="pill mi ui-model${r.model.inherited ? ' inherited' : ''}" title="${r.model.inherited ? tx.modelInherited : tx.model}">${esc(r.model.label)}</span></span>`
      : '<span class="c c-model"></span>';
  }
  if (props.has('sprint')) {
    if (r.sprint) {
      const tipText = r.sprint.late ? tx.lateTip : r.sprint.active ? tx.activeTip : tx.plannedTip;
      html += `<span class="c c-sprint"><span class="pill mi i-sprint${r.sprint.late ? ' late' : ''}" title="${tipText}">${esc(r.sprint.name)}${r.sprint.late ? ` · ${tx.late}` : ''}</span></span>`;
    } else html += '<span class="c c-sprint"></span>';
  }
  if (props.has('project')) html += r.project ? `<span class="c c-project"><span class="pill project" title="${esc(t('Project of {team}', { team: r.team.name }))}">${teamLogoHtml(r.team, '', 14)}${esc(r.project)}</span></span>` : '<span class="c c-project"></span>';
  if (props.has('labels')) html += labelStackHtml(r.labels, 'c c-labels');
  return html;
}

/**
 * At the far right, from right to left: dates or trash info, and left of them the decision (sprint
 * completion). That way the dates line up in every row under their icons in the group header.
 */
function endHtml(r: RowState, props: ReadonlySet<DisplayProp>, trash: boolean) {
  const tx = T();
  let html = '';
  if (trash) {
    html += `<button class="row-restore" data-testid="row-restore" data-cell="restore">${tx.restore}</button><span class="row-date wide">${esc(t('deleted {date}', { date: r.deleted ?? '' }))}</span>`;
  } else {
    if (props.has('updated')) html += `<span class="row-date" title="${tx.updated}">${esc(r.updated)}</span>`;
    if (props.has('created')) html += `<span class="row-date" title="${tx.created}">${esc(r.created)}</span>`;
    if (props.has('snoozed')) html += `<span class="row-date" title="${tx.snoozed}">${esc(r.snoozed ?? '')}</span>`;
  }
  if (r.decision) html += `<span class="pill decision ${r.decision.outcome}" data-testid="row-decision">${esc(r.decision.label)}</span>`;
  return html;
}

/**
 * Row content in two parts, so frequent changes do not regenerate HTML: checkbox, priority and
 * status are separate Svelte elements (only the class changes, e.g. for 50 issues at once); between
 * them sit team logo and identifier (`lead`), then title and right side (`rest`).
 */
export function rowLeadHtml(r: RowState, props: ReadonlySet<DisplayProp>): string {
  let html = '';
  if (props.has('team')) html += teamLogoHtml(r.team, 'p-team');
  if (props.has('id')) html += `<span class="row-key">${esc(r.key)}</span>`;
  return html;
}

export function rowRestHtml(r: RowState, props: ReadonlySet<DisplayProp>, trash: boolean): string {
  let html = '';
  if (r.unread && !trash) html += `<span class="unseen-dot" data-testid="row-unseen" title="${esc(r.inboxText)}"></span>`;
  html += `<span class="row-title" data-testid="row-title">${esc(r.title)}</span>`;
  if (r.pending) html += `<span class="row-tag" data-testid="row-pending">${T().saving}</span>`;
  html += `<span class="row-cols">${colsHtml(r, props)}</span>`;
  const end = endHtml(r, props, trash);
  if (end) html += `<span class="row-end">${end}</span>`;
  return html;
}
