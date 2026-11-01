// Drawing the roadmap export (SELF-113) onto a canvas. Input is only `ExportData`
// (core/src/app/roadmap.ts): public issues with their public texts, so nothing else can end up in
// the picture. Layout: header (logo, title, subtitle, date), then the projects as columns (release
// view) or rows on a time axis (progress), and a legend of the stages. Widths: 1920 (Discord,
// landscape) or 1080 (phone, portrait); `scale` shrinks the whole picture to stay below 8 MB.
import { STAGES, type Stage } from '@selfbound/backend/shared/roadmap';
import { hueColor, type ExportData } from '@selfbound/core/app/roadmap';
import { dayOfString, type ExportColumn, type ExportRow } from '@selfbound/core/roadmap';
import { stripPng } from './png.ts';

export type ExportView = 'roadmap' | 'progress';
export type ExportLayout = 'landscape' | 'portrait';

export interface ExportLabels {
  stage: Record<Stage, string>;
  state: Record<string, string>;
  doneOf: (done: number, total: number) => string;
  period: (column: { period: ExportColumn['period'] }) => string | null;
  quarter: (quarter: number, year: number) => string;
  month: (year: number, month: number) => string;
  today: string;
  empty: string;
  asOf: string | null;
}

export interface RenderOptions {
  view: ExportView;
  layout: ExportLayout;
  dark: boolean;
  subtitle: string | null;
  logo: boolean;
  labels: ExportLabels;
  /** 1 = full width; smaller to stay below the size limit */
  scale?: number;
}

/** Discord's limit for an upload without Nitro. */
export const SIZE_LIMIT = 8 * 1024 * 1024;
/** Browsers draw nothing beyond this height. */
const MAX_HEIGHT = 30_000;
const WIDTH: Record<ExportLayout, number> = { landscape: 1920, portrait: 1080 };
const FONT = '"Inter Variable", Inter, system-ui, sans-serif';

const PALETTE = {
  dark: { bg: '#0e1014', panel: '#171a20', card: '#1e222a', line: '#2b303a', text: '#f1f3f7', muted: '#a8b0bd', subtle: '#727b8a', track: '#262a33' },
  light: { bg: '#f4f5f7', panel: '#ffffff', card: '#f7f8fa', line: '#dfe3e8', text: '#12151a', muted: '#566070', subtle: '#8b94a2', track: '#e8ebef' },
};
const STAGE_COLOR: Record<Stage, string> = { done: '#3fb37f', testing: '#8f7cf7', progress: '#e9b949', planned: '#8e98a8', tentative: '#8e98a8' };

type Palette = (typeof PALETTE)['dark'];
type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------- Images

const imageCache = new Map<string, Promise<ImageBitmap | HTMLImageElement | null>>();

/**
 * Loads an image for the canvas. Through fetch in CORS mode (the query parameter avoids a copy the
 * browser cached without CORS), so the canvas stays exportable; a failure leaves the image out.
 */
export function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement | null> {
  let promise = imageCache.get(url);
  if (!promise) {
    promise = (async () => {
      try {
        const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}export=1`, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.type === 'image/svg+xml') {
          const img = new Image();
          const src = URL.createObjectURL(blob);
          img.src = src;
          try {
            await img.decode();
          } finally {
            setTimeout(() => URL.revokeObjectURL(src), 0);
          }
          return img;
        }
        return await createImageBitmap(blob);
      } catch {
        return null;
      }
    })();
    imageCache.set(url, promise);
  }
  return promise;
}

const sizeOf = (img: ImageBitmap | HTMLImageElement) => ('naturalWidth' in img ? { w: img.naturalWidth || 1, h: img.naturalHeight || 1 } : { w: img.width, h: img.height });

/** Draws an image to fill the box (cropped in the middle), with rounded top corners. */
function cover(ctx: Ctx, img: ImageBitmap | HTMLImageElement, x: number, y: number, w: number, h: number, r: number) {
  const { w: iw, h: ih } = sizeOf(img);
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, [r, r, 0, 0]);
  ctx.clip();
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------- Text

function font(ctx: Ctx, size: number, weight = 450) {
  ctx.font = `${weight} ${size}px ${FONT}`;
}

/** Lines of a text within a width, at most `max` lines (the last one ends in "…"). */
function wrap(ctx: Ctx, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the line: cut it.
      while (ctx.measureText(line).width > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1]!;
  while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
  kept[max - 1] = `${last.trimEnd()}…`;
  return kept;
}

function text(ctx: Ctx, lines: string[], x: number, y: number, lineHeight: number) {
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return lines.length * lineHeight;
}

// ---------------------------------------------------------------- Shared parts

interface Frame {
  W: number;
  pad: number;
  colors: Palette;
  accent: string;
}

/** Header: accent line, logo, title, subtitle, date. Returns its height. */
function header(ctx: Ctx | null, data: ExportData, opts: RenderOptions, frame: Frame, logo: ImageBitmap | HTMLImageElement | null): number {
  const { W, pad, colors, accent } = frame;
  const logoSize = opts.layout === 'portrait' ? 64 : 80;
  const titleSize = opts.layout === 'portrait' ? 48 : 60;
  let x = pad;
  const top = pad + 6;
  if (ctx) {
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, W, 8);
  }
  if (logo && opts.logo) {
    if (ctx) ctx.drawImage(logo, x, top, logoSize, logoSize);
    x += logoSize + 24;
  }
  const measure = ctx ?? scratch();
  font(measure, titleSize, 700);
  const titleLines = wrap(measure, data.title, W - x - pad - (opts.labels.asOf ? 320 : 0), 2);
  let y = top + titleSize * 0.85;
  if (ctx) {
    ctx.fillStyle = colors.text;
    ctx.textBaseline = 'alphabetic';
    text(ctx, titleLines, x, y, titleSize * 1.1);
  }
  y += (titleLines.length - 1) * titleSize * 1.1;
  if (opts.subtitle) {
    font(measure, 26, 450);
    const lines = wrap(measure, opts.subtitle, W - x - pad, 2);
    y += 16;
    if (ctx) {
      ctx.fillStyle = colors.muted;
      text(ctx, lines, x, y + 22, 34);
    }
    y += 22 + (lines.length - 1) * 34;
  }
  if (opts.labels.asOf && ctx) {
    font(ctx, 22, 500);
    ctx.fillStyle = colors.muted;
    ctx.textAlign = 'right';
    ctx.fillText(opts.labels.asOf, W - pad, top + 30);
    ctx.textAlign = 'left';
  }
  return Math.max(y, top + (logo && opts.logo ? logoSize : 0)) + 40;
}

/** Legend of the stages at the bottom. Returns its height. */
function legend(ctx: Ctx | null, opts: RenderOptions, frame: Frame, y: number): number {
  if (!ctx) return 64;
  const { pad, colors } = frame;
  font(ctx, 20, 500);
  let x = pad;
  for (const stage of STAGES) {
    stageDot(ctx, stage, x + 7, y + 24, 7);
    ctx.fillStyle = colors.muted;
    ctx.fillText(opts.labels.stage[stage], x + 22, y + 31);
    x += 22 + ctx.measureText(opts.labels.stage[stage]).width + 32;
  }
  return 64;
}

function stageDot(ctx: Ctx, stage: Stage, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (stage === 'tentative') {
    ctx.strokeStyle = STAGE_COLOR[stage];
    ctx.lineWidth = 2.5;
    ctx.stroke();
  } else {
    ctx.fillStyle = STAGE_COLOR[stage];
    ctx.fill();
  }
}

let scratchCtx: Ctx | null = null;
function scratch(): Ctx {
  scratchCtx ??= document.createElement('canvas').getContext('2d')!;
  return scratchCtx;
}

// ---------------------------------------------------------------- Release view

interface CardBox {
  h: number;
  title: string[];
  summary: string[];
}

const CARD = { pad: 20, gap: 12, title: 26, titleLh: 32, summary: 19, summaryLh: 27, stage: 18 };

function measureCard(ctx: Ctx, card: ExportColumn['groups'][number]['cards'][number], w: number, hasImage: boolean): CardBox {
  const inner = w - CARD.pad * 2;
  font(ctx, CARD.title, 650);
  const title = wrap(ctx, card.title, inner, 3);
  font(ctx, CARD.summary, 450);
  const summary = card.summary ? wrap(ctx, card.summary, inner, 5) : [];
  let h = CARD.pad + 24 + 10 + title.length * CARD.titleLh;
  if (summary.length) h += 8 + summary.length * CARD.summaryLh;
  h += CARD.pad;
  if (hasImage) h += Math.round((w * 9) / 16);
  return { h, title, summary };
}

interface ColumnBox {
  w: number;
  h: number;
  name: string[];
  goal: string[];
  groups: { h: number; cards: CardBox[] }[];
}

function measureColumn(ctx: Ctx, col: ExportColumn, w: number, images: Map<string, ImageBitmap | HTMLImageElement | null>): ColumnBox {
  const inner = w - 48;
  font(ctx, 34, 700);
  const name = wrap(ctx, col.name, inner, 2);
  font(ctx, 19, 450);
  const goal = col.goal ? wrap(ctx, col.goal, inner, 4) : [];
  let h = 28 + name.length * 40 + 12 + 26 + 18 + 10;
  if (goal.length) h += 14 + goal.length * 26;
  h += 24;
  const groups = col.groups.map((g) => {
    const cards = g.cards.map((card) => measureCard(ctx, card, w - 32, !!(card.image && images.get(card.image))));
    return { h: 44 + cards.reduce((sum, c) => sum + c.h + CARD.gap, 0), cards };
  });
  h += groups.reduce((sum, g) => sum + g.h + 8, 0);
  if (col.groups.length === 0) h += 40;
  return { w, h: h + 16, name, goal, groups };
}

function drawColumn(ctx: Ctx, col: ExportColumn, box: ColumnBox, x: number, y: number, h: number, frame: Frame, opts: RenderOptions, images: Map<string, ImageBitmap | HTMLImageElement | null>) {
  const { colors } = frame;
  const tint = col.hue !== null ? hueColor(col.hue) : frame.accent;
  ctx.fillStyle = colors.panel;
  ctx.beginPath();
  ctx.roundRect(x, y, box.w, h, 20);
  ctx.fill();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = tint;
  ctx.beginPath();
  ctx.roundRect(x, y, box.w, 8, [20, 20, 0, 0]);
  ctx.fill();

  let cy = y + 28;
  const cx = x + 24;
  const inner = box.w - 48;
  font(ctx, 34, 700);
  ctx.fillStyle = colors.text;
  cy += text(ctx, box.name, cx, cy + 30, 40);
  // Period and state, then "x of y done".
  font(ctx, 19, 500);
  ctx.fillStyle = colors.muted;
  const meta = [opts.labels.period(col), opts.labels.state[col.state]].filter(Boolean).join(' · ');
  ctx.fillText(meta, cx, cy + 32);
  ctx.textAlign = 'right';
  ctx.fillText(opts.labels.doneOf(col.done, col.total), cx + inner, cy + 32);
  ctx.textAlign = 'left';
  cy += 12 + 26;
  // Progress bar: done share.
  ctx.fillStyle = colors.track;
  ctx.beginPath();
  ctx.roundRect(cx, cy + 4, inner, 10, 5);
  ctx.fill();
  if (col.total > 0 && col.done > 0) {
    ctx.fillStyle = STAGE_COLOR.done;
    ctx.beginPath();
    ctx.roundRect(cx, cy + 4, Math.max(10, (inner * col.done) / col.total), 10, 5);
    ctx.fill();
  }
  cy += 18 + 10;
  if (box.goal.length) {
    font(ctx, 19, 450);
    ctx.fillStyle = colors.muted;
    cy += 14 + text(ctx, box.goal, cx, cy + 34, 26);
  }
  cy += 24;
  if (col.groups.length === 0) {
    font(ctx, 20, 450);
    ctx.fillStyle = colors.subtle;
    ctx.fillText(opts.labels.empty, cx, cy + 20);
  }
  col.groups.forEach((g, gi) => {
    const gbox = box.groups[gi]!;
    font(ctx, 21, 650);
    if (g.hue !== null) {
      ctx.fillStyle = hueColor(g.hue);
      ctx.beginPath();
      ctx.arc(cx + 6, cy + 18, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = colors.text;
    const label = `${g.name}`;
    ctx.fillText(label, cx + (g.hue !== null ? 22 : 0), cy + 25);
    ctx.fillStyle = colors.subtle;
    ctx.fillText(String(g.cards.length), cx + (g.hue !== null ? 22 : 0) + ctx.measureText(label).width + 12, cy + 25);
    let ky = cy + 44;
    const kx = x + 16;
    const kw = box.w - 32;
    g.cards.forEach((card, ci) => {
      const cbox = gbox.cards[ci]!;
      ctx.fillStyle = colors.card;
      ctx.beginPath();
      ctx.roundRect(kx, ky, kw, cbox.h, 14);
      ctx.fill();
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      let iy = ky;
      const img = card.image ? images.get(card.image) : null;
      if (img) {
        const ih = Math.round((kw * 9) / 16);
        cover(ctx, img, kx, ky, kw, ih, 14);
        iy += ih;
      }
      iy += CARD.pad;
      stageDot(ctx, card.stage, kx + CARD.pad + 7, iy + 12, 7);
      font(ctx, CARD.stage, 600);
      ctx.fillStyle = colors.muted;
      ctx.fillText(opts.labels.stage[card.stage], kx + CARD.pad + 22, iy + 18);
      iy += 24 + 10;
      font(ctx, CARD.title, 650);
      ctx.fillStyle = colors.text;
      iy += text(ctx, cbox.title, kx + CARD.pad, iy + 24, CARD.titleLh);
      if (cbox.summary.length) {
        font(ctx, CARD.summary, 450);
        ctx.fillStyle = colors.muted;
        text(ctx, cbox.summary, kx + CARD.pad, iy + 8 + 20, CARD.summaryLh);
      }
      ky += cbox.h + CARD.gap;
    });
    cy += gbox.h + 8;
  });
}

function roadmapLayout(ctx: Ctx, data: ExportData, opts: RenderOptions, frame: Frame, images: Map<string, ImageBitmap | HTMLImageElement | null>) {
  const { W, pad } = frame;
  const gap = 24;
  const minW = opts.layout === 'portrait' ? 440 : 300;
  const n = Math.max(1, data.columns.length);
  const perRow = Math.max(1, Math.min(n, Math.floor((W - 2 * pad + gap) / (minW + gap))));
  const colW = (W - 2 * pad - (perRow - 1) * gap) / perRow;
  const rows: { boxes: ColumnBox[]; cols: ExportColumn[]; h: number }[] = [];
  for (let i = 0; i < data.columns.length; i += perRow) {
    const cols = data.columns.slice(i, i + perRow);
    const boxes = cols.map((c) => measureColumn(ctx, c, colW, images));
    rows.push({ cols, boxes, h: Math.max(...boxes.map((b) => b.h)) });
  }
  return { rows, colW, gap, height: rows.reduce((sum, r) => sum + r.h + gap, 0) };
}

// ---------------------------------------------------------------- Progress view

function progressHeight(rows: ExportRow[]) {
  return 70 + rows.length * 88 + 16;
}

function drawProgress(ctx: Ctx, data: ExportData, opts: RenderOptions, frame: Frame, y: number) {
  const { W, pad, colors } = frame;
  const axis = data.axis;
  const rows = data.rows;
  const nameW = opts.layout === 'portrait' ? 330 : 460;
  const x0 = pad + nameW;
  const trackW = W - pad - x0;
  const height = progressHeight(rows);
  ctx.fillStyle = colors.panel;
  ctx.beginPath();
  ctx.roundRect(pad, y, W - 2 * pad, height, 20);
  ctx.fill();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  if (!axis) return height;
  const span = axis.end - axis.start;
  const px = (day: number) => x0 + ((day - axis.start) / span) * trackW;
  // Axis: quarters and months.
  font(ctx, 20, 650);
  for (const q of axis.quarters) {
    ctx.fillStyle = colors.text;
    ctx.fillText(opts.labels.quarter(q.quarter, q.year), px(q.start) + 10, y + 32);
  }
  font(ctx, 16, 500);
  for (const m of axis.months) {
    const left = px(m.start);
    ctx.strokeStyle = m.month % 3 === 1 ? colors.line : colors.track;
    ctx.lineWidth = m.month % 3 === 1 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(left, y + (m.month % 3 === 1 ? 10 : 44));
    ctx.lineTo(left, y + height - 10);
    ctx.stroke();
    if ((m.days / span) * trackW >= 44) {
      ctx.fillStyle = colors.subtle;
      ctx.fillText(opts.labels.month(m.year, m.month), left + 8, y + 58);
    }
  }
  ctx.strokeStyle = colors.line;
  ctx.beginPath();
  ctx.moveTo(pad, y + 70);
  ctx.lineTo(W - pad, y + 70);
  ctx.stroke();
  rows.forEach((row, i) => {
    const ry = y + 70 + i * 88;
    const mid = ry + 44;
    const tint = row.hue !== null ? hueColor(row.hue) : frame.accent;
    font(ctx, 26, 650);
    ctx.fillStyle = colors.text;
    ctx.fillText(wrap(ctx, row.name, nameW - 150, 1)[0] ?? '', pad + 24, ry + 38);
    font(ctx, 18, 450);
    ctx.fillStyle = colors.muted;
    const sub = [opts.labels.period(row), row.state ? opts.labels.state[row.state] : null].filter(Boolean).join(' · ');
    ctx.fillText(wrap(ctx, sub, nameW - 150, 1)[0] ?? '', pad + 24, ry + 66);
    font(ctx, 22, 600);
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'right';
    ctx.fillText(`${row.done}/${row.total}`, x0 - 24, ry + 38);
    ctx.textAlign = 'left';
    ctx.fillStyle = colors.track;
    ctx.beginPath();
    ctx.roundRect(x0 - 104, ry + 54, 80, 8, 4);
    ctx.fill();
    if (row.total && row.done) {
      ctx.fillStyle = STAGE_COLOR.done;
      ctx.beginPath();
      ctx.roundRect(x0 - 104, ry + 54, Math.max(8, (80 * row.done) / row.total), 8, 4);
      ctx.fill();
    }
    if (row.target !== null && row.end === null && row.target > axis.today) {
      // Started: from today to the end of the period; not started yet: the period itself.
      const from = Math.max(axis.today + 1, row.start ?? (row.period ? dayOfString(row.period.start) : axis.today + 1));
      ctx.strokeStyle = tint;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.roundRect(px(from), mid - 14, Math.max(4, px(row.target + 1) - px(from)), 28, 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (row.start !== null) {
      const end = Math.max(row.start + 1, (row.end ?? axis.today) + 1);
      ctx.fillStyle = tint;
      ctx.globalAlpha = row.end !== null ? 1 : 0.8;
      ctx.beginPath();
      ctx.roundRect(px(row.start), mid - 14, Math.max(6, px(end) - px(row.start)), 28, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    for (const day of row.completions) {
      ctx.fillStyle = colors.panel;
      ctx.beginPath();
      ctx.arc(px(day + 0.5), mid, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = STAGE_COLOR.done;
      ctx.beginPath();
      ctx.arc(px(day + 0.5), mid, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // Today
  const tx = px(axis.today);
  ctx.strokeStyle = frame.accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(tx, y + 70);
  ctx.lineTo(tx, y + height - 8);
  ctx.stroke();
  font(ctx, 16, 650);
  ctx.fillStyle = frame.accent;
  ctx.fillText(opts.labels.today, tx + 6, y + height - 14);
  return height;
}

// ---------------------------------------------------------------- Rendering

export interface Rendered {
  canvas: HTMLCanvasElement;
  /** Content was cut at the maximum height */
  cut: boolean;
}

/** Draws the export at the given scale. */
export async function render(data: ExportData, opts: RenderOptions): Promise<Rendered> {
  await Promise.all([400, 500, 600, 650, 700].map((w) => document.fonts?.load(`${w} 24px "Inter Variable"`).catch(() => [])));
  const scale = opts.scale ?? 1;
  const W = WIDTH[opts.layout];
  const pad = opts.layout === 'portrait' ? 48 : 72;
  const frame: Frame = { W, pad, colors: opts.dark ? PALETTE.dark : PALETTE.light, accent: data.accent };
  const logoUrl = opts.dark ? data.logo.dark : data.logo.light;
  const urls = opts.view === 'roadmap' ? [...new Set(data.columns.flatMap((c) => c.groups.flatMap((g) => g.cards.map((card) => card.image)).filter((u): u is string => !!u)))] : [];
  const [logo, ...bitmaps] = await Promise.all([opts.logo && logoUrl ? loadImage(logoUrl) : Promise.resolve(null), ...urls.map(loadImage)]);
  const images = new Map(urls.map((u, i) => [u, bitmaps[i] ?? null]));

  const measure = scratch();
  const headH = header(null, data, opts, frame, logo ?? null);
  const layout = opts.view === 'roadmap' ? roadmapLayout(measure, data, opts, frame, images) : null;
  const bodyH = layout ? layout.height : progressHeight(data.rows) + 24;
  const full = headH + bodyH + legend(null, opts, frame, 0) + pad;
  const H = Math.min(MAX_HEIGHT, Math.ceil(full));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = frame.colors.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  header(ctx, data, opts, frame, logo ?? null);
  let y = headH;
  if (layout) {
    for (const row of layout.rows) {
      row.cols.forEach((col, i) => drawColumn(ctx, col, row.boxes[i]!, pad + i * (layout.colW + layout.gap), y, row.h, frame, opts, images));
      y += row.h + layout.gap;
    }
  } else {
    y += drawProgress(ctx, data, opts, frame, y) + 24;
  }
  legend(ctx, opts, frame, Math.min(y, H - pad - 64));
  return { canvas, cut: full > MAX_HEIGHT };
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be encoded.'))), 'image/png'));
}

export interface ExportFile {
  blob: Blob;
  width: number;
  height: number;
  scale: number;
  cut: boolean;
}

/** PNG below the size limit: full size first, then smaller until it fits. Metadata chunks removed. */
export async function exportPng(data: ExportData, opts: RenderOptions): Promise<ExportFile> {
  let last: ExportFile | null = null;
  for (const scale of [1, 0.8, 0.65, 0.5]) {
    const { canvas, cut } = await render(data, { ...opts, scale });
    const raw = new Uint8Array(await (await toBlob(canvas)).arrayBuffer());
    const blob = new Blob([stripPng(raw)], { type: 'image/png' });
    last = { blob, width: canvas.width, height: canvas.height, scale, cut };
    if (blob.size <= SIZE_LIMIT) return last;
  }
  return last!;
}

/** File name from the export title: "emberfall-roadmap-2026-11-01.png". */
export function fileName(title: string, view: ExportView, day: string) {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'roadmap';
  return `${slug}-${view === 'progress' ? 'progress' : 'roadmap'}-${day}.png`;
}
