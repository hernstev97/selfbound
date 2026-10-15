// Bar charts: vertical or horizontal; one series, grouped, stacked, or stacked to 100 %.
// Bars are at most 24 px thick with a rounded data end; stacked segments are separated by a gap in
// the surface colour; a value goes inside a segment only if it fits, otherwise it is left to the tooltip.
import type { BarSpec } from './spec.ts';
import { barPath, exact, fit, format, html, niceTicks, slot, svg, textWidth, Tooltip } from './dom.ts';

const THICK = 24;
/** Palette slots whose bar colour needs dark text in both modes (md.css `--chart-on-N`). */
const onSlot = (n: number) => `var(--chart-on-${n})`;

export function drawBars(spec: BarSpec, body: HTMLElement, width: number, label: string) {
  const { series, categories, horizontal } = spec;
  const nc = categories.length;
  const percent = spec.stack === 'percent';
  const stacked = spec.stack !== 'none';
  const totals = categories.map((_, c) => series.reduce((sum, s) => sum + s.values[c]!, 0));
  const shown = series.map((s) => s.values.map((v, c) => (percent ? (totals[c]! ? (v / totals[c]!) * 100 : 0) : v)));
  const base = series.map(() => new Array<number>(nc).fill(0));
  if (stacked) for (let s = 1; s < series.length; s++) for (let c = 0; c < nc; c++) base[s]![c] = base[s - 1]![c]! + shown[s - 1]![c]!;

  const peak = Math.max(...(stacked ? totals : shown.flat()));
  const max = percent ? 100 : peak > 0 ? peak : 1;
  const ticks = percent ? [] : niceTicks(0, max, horizontal ? 5 : 4);
  const hi = percent ? 100 : ticks.at(-1)!;
  const unit = percent ? '%' : spec.unit;
  const tickLabels = ticks.map((v) => format(v, unit));

  const pitch = 38;
  const catLabelW = Math.min(Math.max(...categories.map(textWidth)) + 14, width * 0.35);
  const m = horizontal
    ? { top: 6, right: 16 + (!stacked && series.length === 1 ? textWidth(format(max, unit)) + 8 : 0), bottom: percent ? 6 : 26, left: catLabelW }
    : { top: 16, right: 10, bottom: 28, left: Math.max(percent ? 0 : 1, ...tickLabels.map(textWidth)) + 12 };
  const plotW = Math.max(60, width - m.left - m.right);
  const plotH = horizontal ? nc * pitch : 200;
  const height = m.top + plotH + m.bottom;
  const band = (horizontal ? plotH : plotW) / nc;
  const groups = stacked ? 1 : series.length;
  const thick = Math.min(THICK, (band * 0.7) / groups);
  const val = (v: number) => (horizontal ? m.left + (v / hi) * plotW : m.top + plotH - (v / hi) * plotH);

  const plot = html('div', 'vchart-plot');
  const root = svg('svg', { width, height, class: 'vchart-svg', role: 'img', 'aria-label': label });
  const tip = new Tooltip(plot);

  // Axis and grid (a 100 % stack has none: the segments carry their labels)
  if (!percent) {
    ticks.forEach((v, i) => {
      const at = val(v);
      if (horizontal) {
        root.append(svg('line', { x1: at, x2: at, y1: m.top, y2: m.top + plotH, class: v === 0 ? 'vc-axis' : 'vc-grid' }));
        root.append(svg('text', { x: at, y: height - 8, class: 'vc-tick', 'text-anchor': i === 0 ? 'start' : 'middle' }, tickLabels[i]!));
      } else {
        root.append(svg('line', { x1: m.left, x2: m.left + plotW, y1: at, y2: at, class: v === 0 ? 'vc-axis' : 'vc-grid' }));
        root.append(svg('text', { x: m.left - 8, y: at, class: 'vc-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, tickLabels[i]!));
      }
    });
  }

  // Vertical bars: as many category labels as fit
  const labelEvery = horizontal ? 1 : Math.max(1, Math.ceil((Math.min(Math.max(...categories.map(textWidth)), 90) + 10) / band));
  categories.forEach((name, c) => {
    const start = (horizontal ? m.top : m.left) + c * band + (band - thick * groups) / 2;
    if (horizontal) root.append(svg('text', { x: m.left - 10, y: m.top + c * band + band / 2, class: 'vc-cat', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fit(name, m.left - 14)));
    else if (c % labelEvery === 0) root.append(svg('text', { x: m.left + c * band + band / 2, y: height - 9, class: 'vc-tick', 'text-anchor': 'middle' }, fit(name, band * labelEvery - 6)));

    series.forEach((s, si) => {
      const v0 = base[si]![c]!;
      const v1 = v0 + shown[si]![c]!;
      const offset = stacked ? 0 : si * thick;
      const a = val(v0);
      const b = val(v1);
      const [x, y, w, h] = horizontal ? [Math.min(a, b), start + offset, Math.abs(b - a), thick] : [start + offset, Math.min(a, b), thick, Math.abs(b - a)];
      if (w <= 0 || h <= 0) return;
      const mark = stacked
        ? svg('rect', { x, y, width: w, height: h, fill: slot(s.color), stroke: 'var(--vchart-surface)', 'stroke-width': 2 })
        : svg('path', { d: barPath(x, y, w, h, horizontal), fill: slot(s.color) });
      root.append(mark);
      const text = percent ? `${Math.round(shown[si]![c]!)}%` : stacked ? format(s.values[c]!, spec.unit) : '';
      if (text && (horizontal ? w : h) >= (horizontal ? textWidth(text) + 14 : 18) && (horizontal ? h : w) >= 14 && (horizontal || w >= textWidth(text) + 8)) {
        root.append(svg('text', { x: x + w / 2, y: y + h / 2, class: 'vc-in-label', fill: onSlot(s.color), 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, text));
      }
      // A single series gets its value at the tip (selective: only when there is room)
      if (!stacked && series.length === 1 && nc <= 14) {
        const t = format(s.values[c]!, spec.unit);
        root.append(svg('text', horizontal ? { x: x + w + 8, y: y + h / 2, class: 'vc-value', 'dominant-baseline': 'middle' } : { x: x + w / 2, y: y - 6, class: 'vc-value', 'text-anchor': 'middle' }, t));
      }
      // The whole mark is the hit target, plus the gap around it
      const target = svg('rect', { x: x - 1, y: y - 1, width: w + 2, height: h + 2, fill: 'transparent' });
      const showTip = () => {
        const box = root.getBoundingClientRect();
        const at = target.getBoundingClientRect();
        tip.show(at.left - box.left + at.width / 2, at.top - box.top + at.height / 2, name, [{ slot: s.color, value: percent ? `${Math.round(shown[si]![c]! * 10) / 10}%` : exact(s.values[c]!, spec.unit), label: s.name }]);
      };
      target.addEventListener('pointermove', showTip);
      target.addEventListener('pointerleave', () => tip.hide());
      root.append(target);
    });
  });

  plot.prepend(root);
  body.append(plot);
}
