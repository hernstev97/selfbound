// The ```chart block: a JSON description of the data, checked here into a typed spec. Pure and
// DOM-free so it can be tested on its own. Errors are `Error`s with a message the reader can act on
// (shown under the source); the texts go through t() at call time.
import { t } from '@selfbound/core/i18n';

export const MAX_SOURCE_CHARS = 100_000;
export const MAX_VALUES = 5_000;
/** Categorical slots of the palette (md.css `--chart-1…8`); a ninth series is folded into "Other" by the author. */
export const MAX_SERIES = 8;
/** Larger magnitudes (JSON allows 1e999) would overflow sums and tick computation. */
const MAX_ABS = 1e15;
/** Labels are cut to this many characters. */
const MAX_LABEL = 120;

export type Stack = 'none' | 'stacked' | 'percent';

export interface Series {
  name: string;
  values: number[];
  /** Palette slot 1–8: fixed per series, so a filter that drops one does not repaint the others */
  color: number;
}

interface Common {
  title: string;
  subtitle: string;
  note: string;
}

export interface StatSpec extends Common {
  type: 'stat';
  items: { label: string; value: string; delta: string; trend: number[] }[];
}

export interface XySpec extends Common {
  type: 'line' | 'area';
  x: (string | number)[];
  numericX: boolean;
  xUnit: string;
  series: Series[];
  stack: Stack;
  unit: string;
  yMin: number | null;
  yMax: number | null;
  markers: { x: string | number; series: number; label: string }[];
  rules: { x: string | number; label: string }[];
  /** 'diagonal' (equal use), a y value, or none */
  reference: 'diagonal' | number | null;
}

export interface BarSpec extends Common {
  type: 'bar';
  categories: string[];
  series: Series[];
  stack: Stack;
  horizontal: boolean;
  unit: string;
}

export interface HeatSpec extends Common {
  type: 'heatmap';
  rows: string[];
  columns: string[];
  values: number[][];
  unit: string;
  legend: { low: string; high: string };
}

export type ChartSpec = StatSpec | XySpec | BarSpec | HeatSpec;

const TYPES = ['line', 'area', 'bar', 'heatmap', 'stat'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const missing = (field: string) => new Error(t('"{field}" is missing', { field }));
const wrong = (field: string, expected: string) => new Error(t('"{field}" must be {expected}', { field, expected }));

function text(o: Obj, key: string, path = key): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw wrong(path, t('text'));
  return String(v).slice(0, 300);
}

function required(o: Obj, key: string, path = key): string {
  if (o[key] === undefined) throw missing(path);
  const v = text(o, key, path);
  if (!v) throw missing(path);
  return v;
}

function numbers(v: unknown, path: string): number[] {
  if (!Array.isArray(v)) throw v === undefined ? missing(path) : wrong(path, t('a list of numbers'));
  if (v.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_ABS)) throw wrong(path, t('a list of numbers'));
  return v as number[];
}

function labels(v: unknown, path: string): (string | number)[] {
  if (!Array.isArray(v) || !v.length) throw v === undefined ? missing(path) : wrong(path, t('a list of labels'));
  if (v.some((n) => (typeof n !== 'string' && typeof n !== 'number') || (typeof n === 'number' && (!Number.isFinite(n) || Math.abs(n) > MAX_ABS)))) throw wrong(path, t('a list of labels'));
  return (v as (string | number)[]).map((n) => (typeof n === 'string' ? n.slice(0, MAX_LABEL) : n));
}

function series(v: unknown, length: number, lengthOf: string): Series[] {
  if (!Array.isArray(v) || !v.length) throw v === undefined ? missing('series') : wrong('series', t('a list of series'));
  if (v.length > MAX_SERIES) throw new Error(t('At most {max} series (fold the rest into "Other")', { max: MAX_SERIES }));
  return v.map((s, i) => {
    const path = `series[${i}]`;
    if (!isObj(s)) throw wrong(path, t('an object with "name" and "values"'));
    const values = numbers(s.values, `${path}.values`);
    if (values.length !== length) throw new Error(t('"{field}" has {n} values, "{of}" has {m}', { field: `${path}.values`, n: values.length, of: lengthOf, m: length }));
    const color = s.color === undefined ? i + 1 : s.color;
    if (!Number.isInteger(color) || (color as number) < 1 || (color as number) > MAX_SERIES) throw wrong(`${path}.color`, t('a number from 1 to {max}', { max: MAX_SERIES }));
    return { name: required(s, 'name', `${path}.name`).slice(0, MAX_LABEL), values, color: color as number };
  });
}

function stackOf(o: Obj, allowed: readonly Stack[], fallback: Stack): Stack {
  const v = o.stack;
  if (v === undefined) return fallback;
  if (v === false) return 'none';
  if (v === true) {
    if (!allowed.includes('stacked')) throw wrong('stack', allowed.map((a) => `"${a}"`).join(', '));
    return 'stacked';
  }
  if (typeof v !== 'string' || !allowed.includes(v as Stack)) throw wrong('stack', allowed.map((a) => `"${a}"`).join(', '));
  return v as Stack;
}

function optionalNumber(o: Obj, key: string): number | null {
  if (o[key] === undefined || o[key] === null) return null;
  if (typeof o[key] !== 'number' || !Number.isFinite(o[key]) || Math.abs(o[key] as number) > MAX_ABS) throw wrong(key, t('a number'));
  return o[key] as number;
}

/** Index of `x` in the chart's x values (by value, as text), or an error naming where it came from. */
function findX(x: (string | number)[], v: unknown, path: string): string | number {
  if (typeof v !== 'string' && typeof v !== 'number') throw missing(path);
  if (!x.some((c) => String(c) === String(v))) throw new Error(t('"{field}" is {value}, which is not in "x"', { field: path, value: String(v) }));
  return x.find((c) => String(c) === String(v))!;
}

export function parseChart(source: string): ChartSpec {
  if (source.length > MAX_SOURCE_CHARS) throw new Error(t('Chart text is too long ({n} characters, at most {max})', { n: source.length, max: MAX_SOURCE_CHARS }));
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new Error(t('Invalid JSON: {reason}', { reason: error instanceof Error ? error.message.split('\n')[0]! : String(error) }));
  }
  if (!isObj(raw)) throw wrong('chart', t('a JSON object'));
  const type = raw.type;
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) throw new Error(t('Unknown chart type "{type}" (use {types})', { type: String(type ?? ''), types: TYPES.join(', ') }));
  const common: Common = { title: text(raw, 'title'), subtitle: text(raw, 'subtitle'), note: text(raw, 'note') };
  const unit = text(raw, 'unit');

  if (type === 'stat') {
    const items = raw.items;
    if (!Array.isArray(items) || !items.length) throw items === undefined ? missing('items') : wrong('items', t('a list of tiles'));
    if (items.length > 12) throw new Error(t('At most {max} tiles', { max: 12 }));
    return {
      type,
      ...common,
      items: items.map((item, i) => {
        if (!isObj(item)) throw wrong(`items[${i}]`, t('an object with "label" and "value"'));
        return {
          label: required(item, 'label', `items[${i}].label`),
          value: required(item, 'value', `items[${i}].value`),
          delta: text(item, 'delta'),
          trend: item.trend === undefined ? [] : numbers(item.trend, `items[${i}].trend`),
        };
      }),
    };
  }

  if (type === 'heatmap') {
    const rows = labels(raw.rows, 'rows').map(String).map((x) => x.slice(0, MAX_LABEL));
    const columns = labels(raw.columns, 'columns').map(String);
    const grid = raw.values;
    if (!Array.isArray(grid)) throw grid === undefined ? missing('values') : wrong('values', t('a list of rows of numbers'));
    if (grid.length !== rows.length) throw new Error(t('"{field}" has {n} values, "{of}" has {m}', { field: 'values', n: grid.length, of: 'rows', m: rows.length }));
    const values = grid.map((r, i) => {
      const row = numbers(r, `values[${i}]`);
      if (row.length !== columns.length) throw new Error(t('"{field}" has {n} values, "{of}" has {m}', { field: `values[${i}]`, n: row.length, of: 'columns', m: columns.length }));
      return row;
    });
    if (rows.length * columns.length > MAX_VALUES) throw new Error(t('Chart data is too large ({n} values, at most {max})', { n: rows.length * columns.length, max: MAX_VALUES }));
    const legend = isObj(raw.legend) ? raw.legend : {};
    return { type, ...common, rows, columns, values, unit, legend: { low: text(legend, 'low') || t('fewer'), high: text(legend, 'high') || t('more') } };
  }

  if (type === 'bar') {
    const categories = labels(raw.categories, 'categories').map(String);
    const s = series(raw.series, categories.length, 'categories');
    if (categories.length * s.length > MAX_VALUES) throw new Error(t('Chart data is too large ({n} values, at most {max})', { n: categories.length * s.length, max: MAX_VALUES }));
    if (s.some((v) => v.values.some((n) => n < 0))) throw wrong('series', t('without negative values in a bar chart'));
    const orientation = raw.orientation ?? 'vertical';
    if (orientation !== 'vertical' && orientation !== 'horizontal') throw wrong('orientation', '"vertical", "horizontal"');
    return { type, ...common, categories, series: s, stack: stackOf(raw, ['none', 'stacked', 'percent'], 'none'), horizontal: orientation === 'horizontal', unit };
  }

  // line and area
  const x = labels(raw.x, 'x');
  const s = series(raw.series, x.length, 'x');
  if (x.length * s.length > MAX_VALUES) throw new Error(t('Chart data is too large ({n} values, at most {max})', { n: x.length * s.length, max: MAX_VALUES }));
  const numericX = x.every((v) => typeof v === 'number');
  if (numericX && x.some((v, i) => i > 0 && (v as number) <= (x[i - 1] as number))) throw wrong('x', t('increasing when it holds numbers'));
  const stack = stackOf(raw, type === 'area' ? ['none', 'stacked', 'percent'] : ['none'], 'none');
  if (stack !== 'none' && s.some((v) => v.values.some((n) => n < 0))) throw wrong('series', t('without negative values when stacked'));
  const markers = raw.markers === undefined ? [] : raw.markers;
  const rules = raw.rules === undefined ? [] : raw.rules;
  if (!Array.isArray(markers)) throw wrong('markers', t('a list'));
  if (!Array.isArray(rules)) throw wrong('rules', t('a list'));
  const ref = raw.reference;
  if (ref !== undefined && ref !== null && ref !== 'diagonal' && (typeof ref !== 'number' || !Number.isFinite(ref) || Math.abs(ref) > MAX_ABS)) throw wrong('reference', t('"diagonal" or a number'));
  return {
    type: type as 'line' | 'area',
    ...common,
    x,
    numericX,
    xUnit: text(raw, 'xUnit'),
    series: s,
    stack,
    unit,
    yMin: optionalNumber(raw, 'yMin'),
    yMax: optionalNumber(raw, 'yMax'),
    markers: markers.map((m, i) => {
      if (!isObj(m)) throw wrong(`markers[${i}]`, t('an object with "x" and "label"'));
      const index = m.series === undefined ? 0 : m.series;
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= s.length) throw wrong(`markers[${i}].series`, t('the number of a series (0 is the first)'));
      return { x: findX(x, m.x, `markers[${i}].x`), series: index as number, label: required(m, 'label', `markers[${i}].label`) };
    }),
    rules: rules.map((r, i) => {
      if (!isObj(r)) throw wrong(`rules[${i}]`, t('an object with "x" and "label"'));
      return { x: findX(x, r.x, `rules[${i}].x`), label: required(r, 'label', `rules[${i}].label`) };
    }),
    reference: (ref ?? null) as 'diagonal' | number | null,
  };
}
