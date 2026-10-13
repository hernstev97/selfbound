// Colors for theme mapping: read and write hex, composite over a surface (alpha), mix in OKLab,
// WCAG contrast, and shift lightness until a contrast is met.

/** Color as sRGB 0…1 with opacity. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" (case-insensitive), otherwise null. */
export function parseHex(value: unknown): Rgba | null {
  if (typeof value !== 'string') return null;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
}

const byte = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');

/** "#rrggbb" (opacity dropped). */
export function toHex(c: Rgba): string {
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
}

/** Semi-transparent color composited over an opaque surface. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Relative luminance per WCAG 2. */
export function luminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** Contrast ratio per WCAG 2 (1 to 21). */
export function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

function toOklab(c: Rgba): [number, number, number] {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to linear sRGB, unclamped (values outside 0…1 = out of gamut). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

export function toOklch(c: Rgba): Oklch {
  const [l, a, b] = toOklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

const inGamut = (rgb: number[]) => rgb.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/** OKLCH to sRGB; out of gamut, chroma is reduced while lightness and hue stay. */
export function fromOklch({ l, c, h }: Oklch, alpha = 1): Rgba {
  const L = clamp01(l);
  const rad = (h * Math.PI) / 180;
  let lin = oklabToLinear(L, c * Math.cos(rad), c * Math.sin(rad));
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, mid * Math.cos(rad), mid * Math.sin(rad)))) lo = mid;
      else hi = mid;
    }
    lin = oklabToLinear(L, lo * Math.cos(rad), lo * Math.sin(rad));
  }
  return { r: clamp01(fromLinear(lin[0])), g: clamp01(fromLinear(lin[1])), b: clamp01(fromLinear(lin[2])), a: alpha };
}

/** Mix in OKLab: t = 0 gives a, t = 1 gives b. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const A = toOklab(a);
  const B = toOklab(b);
  const lin = oklabToLinear(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  return { r: clamp01(fromLinear(lin[0])), g: clamp01(fromLinear(lin[1])), b: clamp01(fromLinear(lin[2])), a: 1 };
}

/** Lowest contrast of fg against all surfaces. */
export function minContrast(fg: Rgba, bgs: Rgba[]): number {
  return Math.min(...bgs.map((bg) => contrast(fg, bg)));
}

export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };

/**
 * Shifts the lightness of fg (OKLCH, hue stays) just far enough that its contrast against all
 * surfaces reaches `min`. Direction: away from the lightest or darkest surface, whichever side has
 * more room. If that is not enough, the result is white or black.
 */
export function ensureContrast(fg: Rgba, bgs: Rgba[], min: number): Rgba {
  if (minContrast(fg, bgs) >= min) return fg;
  const base = toOklch(fg);
  const lighter = minContrast(WHITE, bgs) >= minContrast(BLACK, bgs);
  const target = lighter ? 1 : 0;
  let lo = base.l;
  let hi = target;
  if (minContrast(fromOklch({ ...base, l: target }), bgs) < min) return lighter ? WHITE : BLACK;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (minContrast(fromOklch({ ...base, l: mid }), bgs) >= min) hi = mid;
    else lo = mid;
  }
  const out = fromOklch({ ...base, l: hi });
  // Rounding to 8 bits can land just below the threshold: then go one step further.
  let l = hi;
  let rounded = parseHex(toHex(out))!;
  for (let i = 0; i < 50 && minContrast(rounded, bgs) < min; i++) {
    l += lighter ? 0.002 : -0.002;
    rounded = parseHex(toHex(fromOklch({ ...base, l })))!;
  }
  return rounded;
}

/** Is the surface dark (white has more contrast than black)? */
export function isDark(bg: Rgba): boolean {
  return contrast(WHITE, bg) > contrast(BLACK, bg);
}
