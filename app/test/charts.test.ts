// @vitest-environment jsdom
// The ```chart block: the JSON spec is checked with messages a reader can act on, and every type is
// drawn from it (structure, numbers, no markup from data, table view, redraw on resize).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { BLOCKS, blockFor } from '../src/lib/blocks/registry.ts';
import { render } from '../src/lib/blocks/chart/index.ts';
import { compact, niceTicks } from '../src/lib/blocks/chart/dom.ts';
import { parseChart } from '../src/lib/blocks/chart/spec.ts';

const ctx = () => ({ signal: new AbortController().signal });
const draw = (spec: unknown) => {
  const host = document.createElement('div');
  document.body.append(host);
  const description = render(JSON.stringify(spec), host, ctx());
  return { host, description };
};

beforeAll(() => {
  // jsdom has no layout: a fixed width and a ResizeObserver that tests trigger by hand
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(public cb: () => void) {
      observers.push(this);
    }
    observe() {}
    disconnect() {
      disconnected++;
    }
  };
});
const observers: { cb: () => void }[] = [];
let disconnected = 0;

const AREA = { type: 'area', stack: 'percent', x: ['a', 'b', 'c'], series: [{ name: 'One', values: [1, 2, 3] }, { name: 'Two', values: [3, 2, 1] }] };

describe('claim and numbers', () => {
  it('chart is registered as a group, lazily', () => {
    expect(blockFor('chart')?.id).toBe('chart');
    expect(BLOCKS.find((b) => b.id === 'chart')?.role).toBe('group');
  });
  it('nice ticks and compact numbers', () => {
    expect(niceTicks(0, 8, 4)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0, 97, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 0.9, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect([0, 7, 12.34, 1284, 12_940, 4_200_000, 3.2e9].map(compact)).toEqual(['0', '7', '12.3', '1284', '12.9K', '4.2M', '3.2B']);
  });
});

describe('spec', () => {
  it('reads the five types', () => {
    expect(parseChart(JSON.stringify(AREA))).toMatchObject({ type: 'area', stack: 'percent', numericX: false });
    expect(parseChart(JSON.stringify({ type: 'line', x: [0, 50, 100], series: [{ name: 'a', values: [0, 80, 100] }], reference: 'diagonal', markers: [{ x: 50, label: 'half' }] }))).toMatchObject({ numericX: true, reference: 'diagonal' });
    expect(parseChart(JSON.stringify({ type: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }], orientation: 'horizontal', stack: 'stacked' }))).toMatchObject({ horizontal: true, stack: 'stacked' });
    expect(parseChart(JSON.stringify({ type: 'heatmap', rows: ['r'], columns: ['a', 'b'], values: [[1, 2]] }))).toMatchObject({ rows: ['r'], legend: { low: 'fewer', high: 'more' } });
    expect(parseChart(JSON.stringify({ type: 'stat', items: [{ label: 'l', value: 5 }] }))).toMatchObject({ items: [{ value: '5' }] });
  });
  it('slots stay with the series: the order is the default, "color" pins one', () => {
    const spec = parseChart(JSON.stringify({ ...AREA, series: [{ name: 'a', values: [1, 2, 3] }, { name: 'b', values: [1, 2, 3], color: 5 }] }));
    expect((spec as { series: { color: number }[] }).series.map((s) => s.color)).toEqual([1, 5]);
  });
  const bad: [string, unknown, RegExp][] = [
    ['not JSON', 'nope', /Invalid JSON/],
    ['an array', [], /"chart" must be a JSON object/],
    ['unknown type', { type: 'pie' }, /Unknown chart type "pie" \(use line, area, bar, heatmap, stat\)/],
    ['no type', {}, /Unknown chart type ""/],
    ['values of the wrong length', { type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] }, /"series\[0\]\.values" has 1 values, "categories" has 2/],
    ['no series', { type: 'line', x: ['a'] }, /"series" is missing/],
    ['a string in values', { type: 'bar', categories: ['a'], series: [{ name: 's', values: ['1'] }] }, /"series\[0\]\.values" must be a list of numbers/],
    ['nine series', { type: 'bar', categories: ['a'], series: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, values: [1] })) }, /At most 8 series/],
    ['x not increasing', { type: 'line', x: [0, 5, 3], series: [{ name: 's', values: [1, 2, 3] }] }, /"x" must be increasing/],
    ['marker not in x', { ...AREA, type: 'line', stack: undefined, markers: [{ x: 'zzz', label: 'm' }] }, /"markers\[0\]\.x" is zzz, which is not in "x"/],
    ['stacked line', { ...AREA, type: 'line' }, /"stack" must be "none"/],
    ['negative bar', { type: 'bar', categories: ['a'], series: [{ name: 's', values: [-1] }] }, /without negative values in a bar chart/],
    ['heatmap shape', { type: 'heatmap', rows: ['r'], columns: ['a', 'b'], values: [[1]] }, /"values\[0\]" has 1 values, "columns" has 2/],
    ['bad color', { ...AREA, series: [{ name: 'a', values: [1, 2, 3], color: 9 }] }, /"series\[0\]\.color" must be a number from 1 to 8/],
    ['too many values', { type: 'heatmap', rows: Array.from({ length: 100 }, String), columns: Array.from({ length: 100 }, String), values: Array.from({ length: 100 }, () => new Array(100).fill(1)) }, /too large/],
  ];
  it.each(bad)('%s', (_name, spec, message) => {
    expect(() => parseChart(typeof spec === 'string' ? spec : JSON.stringify(spec))).toThrow(message);
  });
  it('too long', () => {
    expect(() => parseChart(`{"type":"stat","items":[],"pad":"${'x'.repeat(100_001)}"}`)).toThrow(/too long/);
  });
});

describe('drawing', () => {
  it('stacked area: one filled band per series, a legend, end labels, a description', () => {
    const { host, description } = draw({ ...AREA, title: 'Share', subtitle: 'per week', rules: [{ x: 'b', label: 'Launch' }] });
    expect(host.querySelectorAll('svg path[fill^="var(--chart-"]').length).toBe(2);
    expect(host.querySelectorAll('.vchart-legend li').length).toBe(2);
    expect(host.querySelector('.vc-rule-label')?.textContent).toBe('Launch');
    expect([...host.querySelectorAll('.vc-end-label')].map((e) => e.textContent)).toEqual(['Two 25%', 'One 75%']); // top band first
    expect(description).toBe('Share. per week. One, Two');
    // the y axis of a 100 % stack
    expect([...host.querySelectorAll('.vc-tick')].map((e) => e.textContent)).toEqual(expect.arrayContaining(['0%', '50%', '100%']));
  });
  it('a single series has no legend and no end label', () => {
    const { host } = draw({ type: 'line', x: [0, 5, 10], series: [{ name: 'Only', values: [1, 4, 9] }], reference: 'diagonal' });
    expect(host.querySelector('.vchart-legend')).toBeNull();
    expect(host.querySelector('.vc-end-label')).toBeNull();
    expect(host.querySelector('.vc-ref')).not.toBeNull();
  });
  it('bars: stacked segments carry their share when they fit; grouped bars have rounded ends', () => {
    const stacked = draw({ type: 'bar', orientation: 'horizontal', stack: 'percent', categories: ['A', 'B'], series: [{ name: 'x', values: [1, 50] }, { name: 'y', values: [99, 50] }] }).host;
    expect(stacked.querySelectorAll('svg rect[fill^="var(--chart-"]').length).toBe(4);
    expect([...stacked.querySelectorAll('.vc-in-label')].map((e) => e.textContent)).toEqual(['99%', '50%', '50%']); // the 1 % segment is too narrow for a label
    const grouped = draw({ type: 'bar', categories: ['A', 'B'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, 4] }] }).host;
    expect(grouped.querySelectorAll('svg path[fill^="var(--chart-"]').length).toBe(4);
  });
  it('heatmap: a cell per value, tinted by its value, a ramp legend', () => {
    const { host } = draw({ type: 'heatmap', rows: ['Mon', 'Tue'], columns: ['a', 'b', 'c'], values: [[0, 5, 10], [10, 5, 0]] });
    const cells = [...host.querySelectorAll<SVGElement>('.vc-cell')];
    expect(cells.length).toBe(6);
    expect(cells[0]!.style.fill).not.toBe(cells[2]!.style.fill);
    expect(host.querySelectorAll('.vchart-ramp i').length).toBe(9);
  });
  it('stat tiles with a trend', () => {
    const { host } = draw({ type: 'stat', items: [{ label: 'runs', value: '24.0M', delta: '+12%', trend: [1, 2, 3] }, { label: 'users', value: 85000 }] });
    expect(host.querySelectorAll('.vchart-stat').length).toBe(2);
    expect(host.querySelector('.vchart-stat-delta')?.textContent).toBe('+12%');
    expect(host.querySelectorAll('.vchart-spark').length).toBe(1);
  });
  it('data never becomes markup', () => {
    const evil = '<img src=x onerror=window.__xss=1>';
    const { host } = draw({ type: 'bar', title: evil, subtitle: evil, note: evil, categories: [evil], series: [{ name: evil, values: [1] }] });
    expect(host.querySelectorAll('img, script').length).toBe(0);
    expect(host.querySelector('.vchart-title')?.textContent).toBe(evil);
    expect((globalThis as { __xss?: number }).__xss).toBeUndefined();
  });
  it('the table view lists every value, and the chart comes back', () => {
    const { host } = draw(AREA);
    const toggle = host.querySelector<HTMLButtonElement>('.vchart-toggle')!;
    toggle.click();
    expect(host.querySelectorAll('table.vchart-table tbody tr').length).toBe(3);
    expect([...host.querySelectorAll('table.vchart-table th')].map((e) => e.textContent)).toEqual(['x', 'One', 'Two']);
    expect(host.querySelector('svg.vchart-svg')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(host.querySelector('svg.vchart-svg')).not.toBeNull();
  });
  it('draws again when the width changes, and stops when the block goes away', () => {
    const before = disconnected;
    const abort = new AbortController();
    const host = document.createElement('div');
    document.body.append(host);
    render(JSON.stringify(AREA), host, { signal: abort.signal });
    const svg = host.querySelector('svg.vchart-svg')!;
    expect(svg.getAttribute('width')).toBe('600');
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(420);
    observers.at(-1)!.cb();
    expect(host.querySelector('svg.vchart-svg')!.getAttribute('width')).toBe('420');
    width.mockRestore();
    abort.abort();
    expect(disconnected).toBe(before + 1);
  });
});
