// Heatmap: rows × columns, one hue, more = stronger (the cell colour mixes the series colour into the surface).
import type { HeatSpec } from './spec.ts';
import { exact, format, html, svg, textWidth, Tooltip } from './dom.ts';

const GAP = 2;

export function drawHeat(spec: HeatSpec, body: HTMLElement, width: number, label: string) {
  const { rows, columns, values } = spec;
  const flat = values.flat();
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  const left = Math.min(Math.max(...rows.map(textWidth)) + 14, width * 0.3);
  const plotW = Math.max(60, width - left - 4);
  const cell = plotW / columns.length;
  const cellH = Math.max(18, Math.min(36, cell * 0.85));
  const top = 4;
  const plotH = rows.length * cellH;
  const height = top + plotH + 26;
  const widest = Math.max(...columns.map(textWidth)) + 12;
  const every = Math.max(1, Math.ceil(widest / cell));
  const tint = (v: number) => `${Math.round(6 + ((hi > lo ? (v - lo) / (hi - lo) : 1) * 94))}%`;

  const plot = html('div', 'vchart-plot');
  const root = svg('svg', { width, height, class: 'vchart-svg', role: 'img', 'aria-label': label });
  const tip = new Tooltip(plot);

  rows.forEach((name, r) => {
    root.append(svg('text', { x: left - 10, y: top + r * cellH + cellH / 2, class: 'vc-cat', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, name));
    columns.forEach((column, c) => {
      const v = values[r]![c]!;
      const x = left + c * cell;
      const y = top + r * cellH;
      const rect = svg('rect', { x: x + GAP / 2, y: y + GAP / 2, width: Math.max(1, cell - GAP), height: cellH - GAP, rx: 3, class: 'vc-cell' });
      rect.style.fill = `color-mix(in oklch, var(--chart-1) ${tint(v)}, var(--vchart-surface))`;
      rect.addEventListener('pointermove', () => {
        const box = root.getBoundingClientRect();
        const at = rect.getBoundingClientRect();
        tip.show(at.left - box.left + at.width / 2, at.top - box.top + at.height / 2, `${name} · ${column}`, [{ value: exact(v, spec.unit), label: '' }]);
      });
      rect.addEventListener('pointerleave', () => tip.hide());
      root.append(rect);
    });
  });
  columns.forEach((column, c) => {
    if (c % every) return;
    root.append(svg('text', { x: left + c * cell + cell / 2, y: height - 8, class: 'vc-tick', 'text-anchor': 'middle' }, column));
  });

  plot.prepend(root);
  // Legend: the ramp from low to high
  const legend = html('div', 'vchart-ramp');
  legend.append(html('span', '', spec.legend.low));
  for (let i = 0; i < 9; i++) {
    const step = html('i');
    step.style.background = `color-mix(in oklch, var(--chart-1) ${6 + (i / 8) * 94}%, var(--vchart-surface))`;
    legend.append(step);
  }
  legend.append(html('span', '', spec.legend.high));
  legend.title = `${format(lo, spec.unit)} – ${format(hi, spec.unit)}`;
  body.append(plot, legend);
}
