// Chart renderer for the ```chart block (JSON spec, see spec.ts): line, area (stacked, 100 %), bar
// (grouped, stacked, 100 %, horizontal), heatmap and stat tiles. Own SVG/HTML, no library; colours
// are CSS variables (md.css), so light, dark and the chosen theme need no redraw. Chart data only
// ever enters the page through textContent.
import { t } from '@selfbound/core/i18n';
import type { BlockContext } from '../registry.ts';
import { drawBars } from './bars.ts';
import { exact, html, slot } from './dom.ts';
import { drawHeat } from './heat.ts';
import { parseChart, type ChartSpec, type Series } from './spec.ts';
import { drawStat } from './stat.ts';
import { drawXy } from './xy.ts';

const seriesOf = (spec: ChartSpec): Series[] => (spec.type === 'line' || spec.type === 'area' || spec.type === 'bar' ? spec.series : []);

/** What a screen reader gets: title, subtitle and what is plotted. */
function describe(spec: ChartSpec): string {
  const names = seriesOf(spec).map((s) => s.name);
  const what = spec.type === 'stat' ? spec.items.map((i) => `${i.label} ${i.value}`) : spec.type === 'heatmap' ? [`${spec.rows.length} × ${spec.columns.length}`] : names;
  return [spec.title, spec.subtitle, what.join(', ')].filter(Boolean).join('. ').slice(0, 400);
}

/** The data as a table: for the reader who wants the numbers, and the way to every value without hovering. */
function tableOf(spec: ChartSpec): HTMLTableElement {
  const table = html('table', 'vchart-table');
  const head = (cells: string[]) => {
    const tr = table.createTHead().insertRow();
    for (const c of cells) tr.append(Object.assign(document.createElement('th'), { textContent: c }));
  };
  const row = (cells: string[]) => {
    const tr = (table.tBodies[0] ?? table.createTBody()).insertRow();
    cells.forEach((c, i) => tr.insertCell().textContent = c || (i ? '' : ' '));
  };
  if (spec.type === 'stat') {
    head([t('Measure'), t('Value'), t('Change')]);
    for (const i of spec.items) row([i.label, i.value, i.delta]);
  } else if (spec.type === 'heatmap') {
    head(['', ...spec.columns]);
    spec.rows.forEach((name, r) => row([name, ...spec.values[r]!.map((v) => exact(v, spec.unit))]));
  } else if (spec.type === 'bar') {
    head(['', ...spec.series.map((s) => s.name)]);
    spec.categories.forEach((name, c) => row([name, ...spec.series.map((s) => exact(s.values[c]!, spec.unit))]));
  } else {
    head([spec.xUnit ? `x (${spec.xUnit})` : 'x', ...spec.series.map((s) => s.name)]);
    spec.x.forEach((x, i) => row([String(x), ...spec.series.map((s) => exact(s.values[i]!, spec.unit))]));
  }
  return table;
}

export function render(source: string, host: HTMLElement, ctx: BlockContext): string {
  const spec = parseChart(source);
  const description = describe(spec);
  const root = html('div', 'vchart');
  const head = html('div', 'vchart-head');
  const titles = html('div', 'vchart-titles');
  if (spec.title) titles.append(html('div', 'vchart-title', spec.title));
  if (spec.subtitle) titles.append(html('div', 'vchart-sub', spec.subtitle));
  const toggle = html('button', 'vchart-toggle', t('Table'));
  toggle.type = 'button';
  toggle.setAttribute('aria-pressed', 'false');
  head.append(titles);
  root.append(head);

  // One series needs no legend (the title says what it is); two or more always do.
  const series = seriesOf(spec);
  if (series.length > 1) {
    const legend = html('ul', 'vchart-legend');
    for (const s of series) {
      const item = html('li');
      const key = html('i', 'vchart-key');
      key.style.background = slot(s.color);
      item.append(key, html('span', '', s.name));
      legend.append(item);
    }
    root.append(legend);
  }
  const body = html('div', 'vchart-body');
  root.append(body);
  // Note on the left, the table toggle on the right (the top right belongs to the block's copy button)
  const foot = html('div', 'vchart-foot');
  foot.append(html('div', 'vchart-note', spec.note), toggle);
  root.append(foot);
  host.replaceChildren(root);

  let table = false;
  let width = 0;
  const paint = () => {
    body.replaceChildren();
    if (table) return void body.append(tableOf(spec));
    width = Math.max(240, Math.floor(body.clientWidth) || 640);
    if (spec.type === 'stat') drawStat(spec, body);
    else if (spec.type === 'heatmap') drawHeat(spec, body, width, description);
    else if (spec.type === 'bar') drawBars(spec, body, width, description);
    else drawXy(spec, body, width, description);
  };
  toggle.addEventListener('click', () => {
    table = !table;
    toggle.textContent = table ? t('Chart') : t('Table');
    toggle.setAttribute('aria-pressed', String(table));
    paint();
  });
  paint();

  // The drawing is laid out for the width it has: draw again when the width changes.
  const observer = new ResizeObserver(() => {
    if (!table && spec.type !== 'stat' && Math.abs(Math.floor(body.clientWidth) - width) > 1) paint();
  });
  observer.observe(body);
  ctx.signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  return description;
}
