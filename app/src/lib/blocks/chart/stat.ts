// Stat tiles: a few headline numbers (label, value, optional change and a tiny trend line). Not a chart.
import type { StatSpec } from './spec.ts';
import { html, svg } from './dom.ts';

export function drawStat(spec: StatSpec, body: HTMLElement) {
  const grid = html('div', 'vchart-stats');
  for (const item of spec.items) {
    const tile = html('div', 'vchart-stat');
    tile.append(html('div', 'vchart-stat-value', item.value), html('div', 'vchart-stat-label', item.label));
    if (item.delta) tile.append(html('div', 'vchart-stat-delta', item.delta));
    if (item.trend.length > 1) tile.append(spark(item.trend));
    grid.append(tile);
  }
  body.append(grid);
}

/** 12-point style sparkline: the history in a muted line, the current value as the accent dot. */
function spark(values: number[]) {
  const [w, h, pad] = [96, 24, 3];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const x = (i: number) => pad + (i / (values.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - (hi > lo ? ((v - lo) / (hi - lo)) * (h - 2 * pad) : (h - 2 * pad) / 2);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return svg('svg', { width: w, height: h, class: 'vchart-spark', 'aria-hidden': 'true' }, svg('path', { d, class: 'vc-spark' }), svg('circle', { cx: x(values.length - 1), cy: y(values.at(-1)!), r: 3, class: 'vc-spark-dot' }));
}
