// Line and area charts (also stacked and 100 % stacked), with an optional reference line, vertical
// rules, labelled markers, end labels and a crosshair tooltip that is also reachable by keyboard.
import type { XySpec } from './spec.ts';
import { exact, format, html, niceTicks, slot, svg, textWidth, Tooltip } from './dom.ts';

const HEIGHT = 260;

/** Draws into `body` (an empty element) at `width` px. */
export function drawXy(spec: XySpec, body: HTMLElement, width: number, label: string) {
  const n = spec.x.length;
  const percent = spec.stack === 'percent';
  const stacked = spec.stack !== 'none';
  const series = spec.series;

  // Plotted values and the base of each layer
  const totals = spec.x.map((_, i) => series.reduce((sum, s) => sum + s.values[i]!, 0));
  const plotted = series.map((s) => s.values.map((v, i) => (percent ? (totals[i]! ? (v / totals[i]!) * 100 : 0) : v)));
  const base = series.map(() => new Array<number>(n).fill(0));
  if (stacked) for (let s = 1; s < series.length; s++) for (let i = 0; i < n; i++) base[s]![i] = base[s - 1]![i]! + plotted[s - 1]![i]!;
  const top = plotted.map((p, s) => p.map((v, i) => base[s]![i]! + v));

  // y scale
  let lo: number;
  let hi: number;
  let ticks: number[];
  if (percent) {
    [lo, hi, ticks] = [0, 100, [0, 25, 50, 75, 100]];
  } else {
    const flat = stacked ? top.flat() : plotted.flat();
    lo = spec.yMin ?? Math.min(0, ...flat);
    hi = spec.yMax ?? Math.max(...flat, lo + 1);
    ticks = niceTicks(lo, hi, 5);
    hi = spec.yMax ?? ticks.at(-1)!;
    lo = spec.yMin ?? ticks[0]!;
  }
  const unit = percent ? '%' : spec.unit;
  const yLabels = ticks.map((v) => format(v, unit));

  // Direct labels at the right edge: the last value of each series (stacked: the middle of its band)
  const endLabels: { y: number; text: string; slot: number }[] = [];
  const last = n - 1;
  series.forEach((s, si) => {
    const mid = stacked ? base[si]![last]! + plotted[si]![last]! / 2 : plotted[si]![last]!;
    const value = percent ? `${Math.round(plotted[si]![last]!)}%` : format(s.values[last]!, spec.unit);
    endLabels.push({ y: mid, text: stacked || (series.length > 1 && series.length <= 4) ? `${s.name} ${value}` : '', slot: s.color });
  });
  const labelWidth = Math.min(Math.max(...endLabels.map((l) => textWidth(l.text))) + 10, width * 0.34);

  const m = { top: 14, right: spec.series.length > 0 && endLabels.some((l) => l.text) ? labelWidth : 14, bottom: 26, left: Math.max(...yLabels.map(textWidth)) + 12 };
  const plotW = Math.max(60, width - m.left - m.right);
  const plotH = HEIGHT - m.top - m.bottom;

  const xNum = spec.numericX ? (spec.x as number[]) : null;
  const xMin = xNum ? xNum[0]! : 0;
  const xMax = xNum ? xNum[n - 1]! : n - 1;
  const px = (i: number) => m.left + (n === 1 ? plotW / 2 : (((xNum ? xNum[i]! : i) - xMin) / (xMax - xMin || 1)) * plotW);
  const xValue = (v: number) => m.left + ((v - xMin) / (xMax - xMin || 1)) * plotW;
  const py = (v: number) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
  const xText = (i: number) => `${spec.x[i]}${spec.xUnit}`;

  const plot = html('div', 'vchart-plot');
  const root = svg('svg', { width, height: HEIGHT, class: 'vchart-svg', role: 'img', 'aria-label': label, tabindex: 0 });

  // Grid and y axis: hairlines, recessive
  ticks.forEach((v, i) => {
    root.append(svg('line', { x1: m.left, x2: m.left + plotW, y1: py(v), y2: py(v), class: v === lo ? 'vc-axis' : 'vc-grid' }));
    root.append(svg('text', { x: m.left - 8, y: py(v), class: 'vc-tick', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, yLabels[i]!));
  });

  // x axis labels: as many as fit
  const xLabels: { at: number; text: string }[] = [];
  if (xNum) {
    for (const v of niceTicks(xMin, xMax, Math.max(2, Math.floor(plotW / 90)))) if (v >= xMin && v <= xMax) xLabels.push({ at: xValue(v), text: `${format(v)}${spec.xUnit}` });
  } else {
    const widest = Math.max(...spec.x.map((v) => textWidth(`${v}${spec.xUnit}`))) + 14;
    const every = Math.max(1, Math.ceil((widest * n) / plotW));
    for (let i = 0; i < n; i += every) xLabels.push({ at: px(i), text: xText(i) });
  }
  for (const l of xLabels) root.append(svg('text', { x: l.at, y: HEIGHT - 8, class: 'vc-tick', 'text-anchor': xLabels.length > 1 && l.at < m.left + 12 ? 'start' : l.at > m.left + plotW - 12 ? 'end' : 'middle' }, l.text));

  // Marks
  const line = (values: number[]) => values.map((v, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join('');
  series.forEach((s, si) => {
    if (spec.type === 'area') {
      const upper = top[si]!;
      const lower = base[si]!;
      const d = `${line(upper)}${lower.map((_, k) => `L${px(n - 1 - k).toFixed(1)},${py(lower[n - 1 - k]!).toFixed(1)}`).join('')}Z`;
      root.append(svg('path', { d, fill: slot(s.color), 'fill-opacity': stacked ? 1 : 0.12, stroke: stacked ? 'var(--vchart-surface)' : 'none', 'stroke-width': stacked ? 1.5 : 0, 'stroke-linejoin': 'round' }));
    }
    if (!stacked) root.append(svg('path', { d: line(plotted[si]!), fill: 'none', stroke: slot(s.color), 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  });

  if (spec.reference !== null) {
    const ref = spec.reference === 'diagonal' ? { x1: m.left, y1: py(lo), x2: m.left + plotW, y2: py(hi) } : { x1: m.left, y1: py(spec.reference), x2: m.left + plotW, y2: py(spec.reference) };
    root.append(svg('line', { ...ref, class: 'vc-ref' }));
  }

  const indexOf = (x: string | number) => spec.x.findIndex((v) => String(v) === String(x));
  for (const rule of spec.rules) {
    const at = px(indexOf(rule.x));
    root.append(svg('line', { x1: at, x2: at, y1: m.top, y2: m.top + plotH, class: 'vc-rule' }));
    const left = at > m.left + plotW * 0.6;
    root.append(svg('text', { x: at + (left ? -6 : 6), y: m.top + 10, class: 'vc-rule-label', 'text-anchor': left ? 'end' : 'start' }, rule.label));
  }

  for (const marker of spec.markers) {
    const i = indexOf(marker.x);
    const s = series[marker.series]!;
    const at = px(i);
    const y = py(top[marker.series]![i]!);
    root.append(svg('circle', { cx: at, cy: y, r: 4, fill: slot(s.color), stroke: 'var(--vchart-surface)', 'stroke-width': 2 }));
    const right = at < m.left + plotW * 0.7;
    root.append(svg('text', { x: at + (right ? 10 : -10), y: y + 16, class: 'vc-mark-label', 'text-anchor': right ? 'start' : 'end' }, marker.label));
  }

  // End labels; where they would overlap the later one is dropped (the legend and tooltip carry it)
  let lastY = -Infinity;
  for (const l of [...endLabels].sort((a, b) => b.y - a.y)) {
    if (!l.text) continue;
    const y = py(l.y);
    if (y - lastY < 15) continue;
    lastY = y;
    root.append(svg('text', { x: m.left + plotW + 8, y, class: 'vc-end-label', 'dominant-baseline': 'middle' }, l.text));
  }

  // Hover and keyboard: the crosshair finds the x, one tooltip lists every series
  const tip = new Tooltip(plot);
  const cross = svg('line', { y1: m.top, y2: m.top + plotH, class: 'vc-cross' });
  const dots = series.map((s) => svg('circle', { r: 4, fill: slot(s.color), stroke: 'var(--vchart-surface)', 'stroke-width': 2 }));
  const layer = svg('g', { visibility: 'hidden', 'pointer-events': 'none' }, cross, ...dots);
  root.append(layer);
  let active = -1;
  const show = (i: number) => {
    active = Math.max(0, Math.min(n - 1, i));
    const at = px(active);
    cross.setAttribute('x1', String(at));
    cross.setAttribute('x2', String(at));
    series.forEach((_, si) => {
      dots[si]!.setAttribute('cx', String(at));
      dots[si]!.setAttribute('cy', String(py(top[si]![active]!)));
    });
    layer.setAttribute('visibility', 'visible');
    const order = stacked ? [...series.keys()].reverse() : [...series.keys()];
    tip.show(at, m.top + 10, xText(active), order.map((si) => ({ slot: series[si]!.color, value: percent ? `${Math.round(plotted[si]![active]! * 10) / 10}%` : exact(series[si]!.values[active]!, spec.unit), label: series[si]!.name })));
  };
  const hide = () => {
    active = -1;
    layer.setAttribute('visibility', 'hidden');
    tip.hide();
  };
  const hit = svg('rect', { x: m.left, y: m.top, width: plotW, height: plotH, fill: 'transparent' });
  hit.addEventListener('pointermove', (event) => {
    const box = root.getBoundingClientRect();
    const x = event.clientX - box.left;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(px(i) - x) < Math.abs(px(best) - x)) best = i;
    show(best);
  });
  hit.addEventListener('pointerleave', hide);
  root.insertBefore(hit, layer);
  root.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step) show(active < 0 ? (step > 0 ? 0 : n - 1) : active + step);
    else if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(n - 1);
    else if (event.key === 'Escape' && active >= 0) hide();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  root.addEventListener('blur', hide);

  plot.prepend(root);
  body.append(plot);
}
