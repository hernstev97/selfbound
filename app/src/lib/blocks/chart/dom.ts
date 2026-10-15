// Small helpers for the chart renderer: SVG/HTML building (text only through textContent, so chart
// data, which often comes from tool output, can never become markup), number formatting, ticks,
// and the hover tooltip.
const NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | null | undefined>;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
  return node;
}

export function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Palette slot as a CSS color (the variables live in md.css and follow light and dark). */
export const slot = (n: number) => `var(--chart-${n})`;

/** Width of a 12 px label, estimated: layout must not wait for the browser to measure. */
export const textWidth = (text: string) => Math.ceil(text.length * 6.6);

/** 1,2,5 × 10^n steps: `count` or so ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min, min + 1];
  const raw = (max - min) / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const ticks: number[] = [];
  const start = Math.floor(min / step) * step;
  for (let i = 0; i < 60; i++) {
    const v = Math.round((start + i * step) * 1e6) / 1e6;
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

/** 1,284 · 12.9K · 4.2M; at most one decimal for the compact forms. */
export function compact(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number, d: number) => String(Math.round(v * 10 ** d) / 10 ** d);
  if (abs >= 1e9) return `${trim(n / 1e9, 1)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6, 1)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3, 1)}K`;
  return trim(n, abs < 10 ? 2 : abs < 100 ? 1 : 0);
}

export const format = (n: number, unit = '') => `${compact(n)}${unit}`;

/** Full precision for tooltips and tables: 1,284.5 */
export const exact = (n: number, unit = '') => `${Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 100) / 100).toLocaleString()}${unit}`;

export interface TipRow {
  /** Palette slot of the series, for the line key */
  slot?: number;
  value: string;
  label: string;
}

/** One tooltip per chart: value first and strong, the series name after it, a short line key. */
export class Tooltip {
  readonly el = html('div', 'vchart-tip');
  constructor(private readonly plot: HTMLElement) {
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    plot.append(this.el);
  }

  show(x: number, y: number, title: string, rows: TipRow[]) {
    const el = this.el;
    el.replaceChildren(html('div', 'vchart-tip-title', title));
    for (const row of rows) {
      const line = html('div', 'vchart-tip-row');
      if (row.slot) {
        const key = html('span', 'vchart-tip-key');
        key.style.background = slot(row.slot);
        line.append(key);
      }
      line.append(html('strong', '', row.value), html('span', 'vchart-tip-label', row.label));
      el.append(line);
    }
    el.hidden = false;
    // Next to the pointer, on the other side near the right edge; never outside the plot.
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    const maxX = this.plot.clientWidth - width - 4;
    el.style.left = `${Math.max(4, x + 14 > maxX ? x - width - 14 : x + 14)}px`;
    el.style.top = `${Math.max(0, Math.min(y - height / 2, this.plot.clientHeight - height))}px`;
  }

  hide() {
    this.el.hidden = true;
  }
}

/** Path of a rectangle whose far end (right for horizontal bars, top for vertical) is rounded. */
export function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, radius = 4): string {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2, horizontal ? w : h));
  if (horizontal) return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
  return `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`;
}
